import type { Layout } from '../../world/layout.ts'
import type { WaterColumns } from './columns.ts'
import { SPRING_RATES, SPRING_SCALE, SUB } from './constants.ts'
import type { UnderSegments } from './under.ts'

/** The water cycle (spec §3 Sea and springs; plan decisions 7–9). */
export class WaterCycle {
  /** From the generator's configure(): sea columns sit at seaLevel × SUB. 0: no sea, and springs are unbounded. */
  seaLevel = 0
  /** The sea account (1/SUB block): credited by water that reaches the sea, debited by springs. Negative only without a sea level. */
  sea = 0
  /** The loss account (1/SUB block): water the loss pass (WaterOptions.lossEvery) took out of the world. Never negative. Mixed and saved by WaterSystem only while loss is on. */
  lost = 0
  /** 1 for a sea column. */
  readonly mask: Uint8Array
  /** Spring positions (Layout.voxelIndex) in the order they were found. */
  readonly springs = new Set<number>()
  private stack = new Int32Array(0)

  constructor(n: number) { this.mask = new Uint8Array(n) }

  /** Marks the sea: wet columns whose surface is at sea level, 4-connected to the world edge through such columns. */
  findSea(cols: WaterColumns): void {
    const mask = this.mask, sx = cols.sx, sz = cols.sz
    mask.fill(0)
    if (this.seaLevel <= 0) return
    if (this.stack.length < cols.n) this.stack = new Int32Array(cols.n)
    const stack = this.stack, target = this.seaLevel * SUB
    let top = 0
    const push = (c: number): void => {
      if (mask[c] === 1 || cols.depth[c]! <= 0 || cols.surface(c) !== target) return
      mask[c] = 1
      stack[top++] = c
    }
    for (let x = 0; x < sx; x++) { push(x); push(x + (sz - 1) * sx) }
    for (let z = 0; z < sz; z++) { push(z * sx); push(sx - 1 + z * sx) }
    while (top > 0) {
      const c = stack[--top]!, x = c % sx, z = (c - x) / sx
      if (x > 0) push(c - 1)
      if (x + 1 < sx) push(c + 1)
      if (z > 0) push(c - sx)
      if (z + 1 < sz) push(c + sx)
    }
  }

  /** Water the sea columns hold. */
  seaDepth(cols: WaterColumns): number {
    let s = 0
    for (let c = 0; c < cols.n; c++) if (this.mask[c] === 1) s += cols.depth[c]!
    return s
  }

  /**
   * Each spring adds its rate to the segment resting on it (its floor is the spring's top: the top segment or a lower one,
   * plan decision 10), at most what the sea holds when the world has a sea level, at most a lower segment's room, and, for a
   * spring with a head (`head`: blocks per id, 0 = none), at most `headRoom` — nothing once the water resting on it is `head`
   * blocks above the spring's top; the sea pays for it. `filled(i)` hears of a lower segment it filled. A position that no
   * longer holds a spring is forgotten.
   */
  runSprings(cols: WaterColumns, under: UnderSegments, layout: Layout, get: (x: number, y: number, z: number) => number, source: Uint8Array,
    filled: (i: number) => void, head: Uint8Array | null = null): void {
    for (const s of this.springs) {
      const [x, y, z] = layout.voxelCoords(s)
      const v = get(x, y, z)
      if (source[v & 0xfff] !== 1) { this.springs.delete(s); continue }
      const c = x + z * cols.sx
      let low = -1
      if (cols.floor[c] !== y + 1) {
        for (let i = under.first[c]!; i >= 0; i = under.next[i]!) if (under.floor[i] === y + 1) { low = i; break }
        if (low < 0) continue
      }
      let rate = SPRING_RATES[(v >>> 12) & 15]! * SPRING_SCALE
      if (this.seaLevel > 0) rate = Math.min(rate, Math.max(0, this.sea))
      if (low >= 0) rate = Math.min(rate, Math.max(0, under.cap(low) - under.depth[low]!))
      const h = head === null ? 0 : head[v & 0xfff]!
      if (h > 0) rate = Math.min(rate, this.headRoom(cols, under, x, z, low, (y + 1 + h) * SUB))
      if (rate <= 0) continue
      if (low < 0) cols.depth[c] = cols.depth[c]! + rate
      else {
        under.depth[low] = under.depth[low]! + rate
        if (under.depth[low]! >= under.cap(low)) filled(low)
      }
      this.sea -= rate
      cols.tiles.wake(cols.tiles.of(x, z))
    }
  }

  /**
   * What a headed spring may add: half the room between `target` (its head, 1/SUB block) and the highest surface of the
   * water resting on it — its own segment and the wet segments beside it that touch it. Measuring the neighbours too and
   * closing only half the gap each step keeps the momentum of the inflow from carrying the pool past the head (a pool
   * settles within a few 1/SUB of it); a spring pouring into an emptying channel still has its whole room, so it keeps
   * its full rate up to half its head.
   */
  private headRoom(cols: WaterColumns, under: UnderSegments, x: number, z: number, low: number, target: number): number {
    const c = x + z * cols.sx, sx = cols.sx
    const lo = low < 0 ? cols.floor[c]! : under.floor[low]!, hi = low < 0 ? 0x7fff : under.ceil[low]!
    const own = low < 0 ? cols.surface(c) : under.surface(low)
    let top = own
    if (x > 0) top = Math.max(top, peak(cols, under, c - 1, lo, hi, own))
    if (x + 1 < sx) top = Math.max(top, peak(cols, under, c + 1, lo, hi, own))
    if (z > 0) top = Math.max(top, peak(cols, under, c - sx, lo, hi, own))
    if (z + 1 < cols.sz) top = Math.max(top, peak(cols, under, c + sx, lo, hi, own))
    const room = target - top
    return room <= 0 ? 0 : Math.max(1, room >> 1)
  }

  mixState(mix: (v: number) => void): void {
    mix(this.seaLevel); mix(this.sea)
    mix(this.springs.size)
    for (const s of this.springs) mix(s)
    for (let c = 0; c < this.mask.length; c++) mix(this.mask[c]!)
  }
}

/**
 * The highest surface (1/SUB block) of column c's wet segments that touch a segment spanning cells [lo, hi) whose surface
 * is `own`: they share a height and rest no higher than `own` (water on a ledge above it is not its pool). −1 when none.
 */
function peak(cols: WaterColumns, under: UnderSegments, c: number, lo: number, hi: number, own: number): number {
  let top = -1
  for (let i = under.first[c]!; i >= 0; i = under.next[i]!) {
    if (under.depth[i]! > 0 && under.floor[i]! < hi && under.ceil[i]! > lo && under.floor[i]! * SUB <= own) top = Math.max(top, under.surface(i))
  }
  if (cols.depth[c]! > 0 && cols.floor[c]! < hi && cols.floor[c]! * SUB <= own) top = Math.max(top, cols.surface(c))
  return top
}
