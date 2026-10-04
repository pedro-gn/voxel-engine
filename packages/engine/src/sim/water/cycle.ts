import type { Layout } from '../../world/layout.ts'
import type { WaterColumns } from './columns.ts'
import { SPRING_RATES, SPRING_SCALE, SUB } from './constants.ts'

/** The water cycle (spec §3 Sea and springs; plan decisions 7–9). */
export class WaterCycle {
  /** From the generator's configure(): sea columns sit at seaLevel × SUB. 0: no sea, and springs are unbounded. */
  seaLevel = 0
  /** The sea account (1/SUB block): credited by water that reaches the sea, debited by springs. Negative only without a sea level. */
  sea = 0
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
   * Each spring that is its column's floor block adds its rate to the column, at most what the sea holds when the world has
   * a sea level, and the sea pays for it. A position that no longer holds a spring is forgotten.
   */
  runSprings(cols: WaterColumns, layout: Layout, get: (x: number, y: number, z: number) => number, source: Uint8Array): void {
    for (const s of this.springs) {
      const [x, y, z] = layout.voxelCoords(s)
      const v = get(x, y, z)
      if (source[v & 0xfff] !== 1) { this.springs.delete(s); continue }
      const c = x + z * cols.sx
      if (cols.floor[c] !== y + 1) continue
      let rate = SPRING_RATES[(v >>> 12) & 15]! * SPRING_SCALE
      if (this.seaLevel > 0) rate = Math.min(rate, Math.max(0, this.sea))
      if (rate <= 0) continue
      cols.depth[c] = cols.depth[c]! + rate
      this.sea -= rate
      cols.tiles.wake(cols.tiles.of(x, z))
    }
  }

  mixState(mix: (v: number) => void): void {
    mix(this.seaLevel); mix(this.sea)
    mix(this.springs.size)
    for (const s of this.springs) mix(s)
    for (let c = 0; c < this.mask.length; c++) mix(this.mask[c]!)
  }
}
