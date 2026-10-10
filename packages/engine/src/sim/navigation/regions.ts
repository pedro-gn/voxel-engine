import type { Layout } from '../../world/layout.ts'
import { edgeCost, type NavigationSystem } from './navigation.ts'
import { IdHeap } from './heap.ts'

export const UNREACHED = 0xffff
/**
 * Build steps (pose cells, edges, crossings, field pops and relaxations, and the synchronous passes between phases)
 * charged as one navigation operation: a build step costs a fraction of a flat search's operation, whose neighbour
 * probes read several voxels. Provisional; calibrated by the bench's op-cost and build-cost probes.
 */
export const BUILD_WEIGHT = 4
/** Exits per region that fit in an exit key. */
const MAX_EXITS = 4095, RUN = 8
/** A run of crossings to one neighbour region, represented by its middle crossing: `from` in the region, `to` beyond it. */
export interface Exit { from: number; to: number; cost: number; target: number }
/** Geometry-only abstract record of one 16³ navigation tile. */
export interface Region {
  index: number; epoch: number
  /** local cell (x + z*16 + y*256) → pose slot, -1 when not a pose */
  slots: Int16Array
  poses: Int32Array        // slot → world voxel index
  /** forward edges: 4 per slot, slot of the target inside the region or -1 (edges leaving the region are exits) */
  next: Int16Array
  exits: Exit[]
  /** fields[e * poses.length + slot] = cost from slot to exits[e].from inside the region, UNREACHED if none */
  fields: Uint16Array
  /** More runs than an exit key can address: searches that need this region end limited. */
  overflow: boolean
  /** Bit k set when tile SOURCES[k] may hold poses that step into this region (conservative, from this region's poses). */
  sources: number
  bytes: number
}
/** Exit keys used by route and group searches: 1 + region * 4096 + exit index. */
export const exitKey = (region: number, e: number): number => 1 + region * 4096 + e
export const splitKey = (key: number): [region: number, e: number] => [Math.floor((key - 1) / 4096), (key - 1) % 4096]
export const localOf = (L: Layout, p: number): number => { const [x, y, z] = L.voxelCoords(p); return (x & 15) + ((z & 15) << 4) + ((y & 15) << 8) }
/** Region slot of a world pose, or -1 when it is not a pose of the region. */
export const slotOf = (region: Region, p: number, L: Layout): number => {
  const slot = region.slots[localOf(L, p)]!
  return slot >= 0 && region.poses[slot] === p ? slot : -1
}
/** Tiles whose poses can step into a tile: the tile below or above, or a face neighbour one tile down, level or up. */
export const SOURCES: readonly (readonly [number, number, number])[] = [[0, -1, 0], [0, 1, 0], ...[-1, 0, 1].flatMap(dy => [[1, dy, 0], [-1, dy, 0], [0, dy, 1], [0, dy, -1]] as [number, number, number][])]
/** Climbs rise one block and drops fall at most two: which source tiles can land on a pose at local (x, y, z). */
function sourceBits(x: number, y: number, z: number): number {
  let bits = 0
  SOURCES.forEach(([dx, dy, dz], k) => {
    const face = dx === 1 ? x === 15 : dx === -1 ? x === 0 : dz === 1 ? z === 15 : dz === -1 ? z === 0 : true
    if (face && (dy === 0 ? dx !== 0 || dz !== 0 : dy < 0 ? y === 0 : y >= 14)) bits |= 1 << k
  })
  return bits
}
interface Crossing { slot: number; d: number; to: number; cost: number; target: number; sy: number; ty: number; along: number; across: number }
type Phase = 'poses' | 'edges' | 'exits' | 'reverse' | 'fields' | 'done'
const PHASES: readonly Phase[] = ['poses', 'edges', 'exits', 'reverse', 'fields', 'done']
export type BuildPhase = Exclude<Phase, 'done'>

/**
 * Builds a Region in slices: one step per cell, edge, crossing, pop or relaxation, and the passes between phases as
 * debt; BUILD_WEIGHT steps are charged as one operation. Restarts if its tile changes. Region poses exclude poses
 * whose support block falls (the live policy always rejects them), so routes never plan across sand.
 */
export class RegionBuild {
  readonly index: number
  done = false
  /** Steps spent per phase, for the bench's cost table; not simulation state. */
  readonly counts: Record<BuildPhase, number> = { poses: 0, edges: 0, exits: 0, reverse: 0, fields: 0 }
  private debt = 0
  private built: Region | null = null
  private readonly nav: NavigationSystem
  private readonly origin: [number, number, number]
  private epoch = 0
  private phase: Phase = 'poses'
  private cursor = 0
  private slots = new Int16Array(4096)
  private locals = new Int16Array(4096)
  private count = 0
  private poses = new Int32Array(0)
  private next = new Int16Array(0)
  private degree = new Int32Array(0)
  private revStart = new Int32Array(0)
  private rev = new Int16Array(0)
  private fill = new Int32Array(0)
  private crossings: Crossing[] = []
  private exits: Exit[] = []
  private runs: Crossing[][] = []
  private fields = new Uint16Array(0)
  private overflow = false
  private sources = 0
  private readonly heap = new IdHeap()
  private field = 0
  private expanding = -1
  private edge = 0
  constructor(nav: NavigationSystem, index: number) {
    this.nav = nav; this.index = index
    const tx = nav.port.layout.size[0] >> 4, tz = nav.port.layout.size[2] >> 4
    this.origin = [(index % tx) << 4, Math.floor(index / (tx * tz)) << 4, (Math.floor(index / tx) % tz) << 4]
    this.restart()
  }
  get stage(): Phase { return this.phase }
  private charge(steps: number): void { this.debt += steps; if (this.phase !== 'done') this.counts[this.phase] += steps }
  private restart(): void {
    this.epoch = this.nav.revisions[this.index]!; this.phase = 'poses'; this.cursor = 0; this.count = 0; this.charge(256)
    this.slots = new Int16Array(4096).fill(-1); this.crossings = []; this.exits = []; this.runs = []; this.overflow = false; this.sources = 0
    this.heap.clear(); this.field = 0; this.expanding = -1; this.edge = 0
  }
  private cost(a: number, b: number): number { const ya = this.locals[a]! >> 8, yb = this.locals[b]! >> 8; return 4 + (yb > ya ? 2 : ya - yb) }
  /** Returns charged operations, at most `cap`. */
  step(cap: number): number {
    let used = 0
    if (this.done) return 0
    if (this.nav.revisions[this.index] !== this.epoch) this.restart()
    const L = this.nav.port.layout, [ox, oy, oz] = this.origin, limit = cap * BUILD_WEIGHT
    while (used < limit && !this.done) {
      if (this.debt) { const pay = Math.min(this.debt, limit - used); this.debt -= pay; used += pay; continue }
      used++
      if (this.phase !== 'done') this.counts[this.phase]++
      if (this.phase === 'poses') {
        const c = this.cursor++, x = ox + (c & 15), z = oz + ((c >> 4) & 15), y = oy + (c >> 8)
        if (this.nav.regionStand(x, y, z)) { this.slots[c] = this.count; this.locals[this.count++] = c; this.sources |= sourceBits(c & 15, c >> 8, (c >> 4) & 15) }
        if (this.cursor === 4096) {
          const P = this.count
          this.poses = new Int32Array(P); this.next = new Int16Array(P * 4).fill(-1); this.degree = new Int32Array(P)
          for (let s = 0; s < P; s++) { const l = this.locals[s]!; this.poses[s] = L.voxelIndex(ox + (l & 15), oy + (l >> 8), oz + ((l >> 4) & 15)) }
          this.charge(P); this.phase = 'edges'; this.cursor = 0
        }
      } else if (this.phase === 'edges') {
        if (this.cursor === this.count * 4) { this.sortCrossings(); this.phase = 'exits'; this.cursor = 0; continue }
        const slot = this.cursor >> 2, d = this.cursor & 3, pose = this.poses[slot]!, to = this.nav.neighbor(pose, d)
        this.cursor++
        if (to < 0) continue
        const target = this.nav.tileOfPose(to)
        // A neighbour the region layer does not stand on (sand) is no edge and no crossing.
        if (target === this.index) { const t = this.slots[localOf(L, to)]!; if (t >= 0) { this.next[slot * 4 + d] = t; this.degree[t]!++ }; continue }
        const [fx, fy, fz] = L.voxelCoords(pose), [tx, ty, tz] = L.voxelCoords(to)
        if (!this.nav.regionStand(tx, ty, tz)) continue
        this.crossings.push({ slot, d, to, cost: edgeCost(L, pose, to), target, sy: fy, ty, along: d < 2 ? fx : fz, across: d < 2 ? fz : fx })
      } else if (this.phase === 'exits') {
        const cr = this.crossings
        if (this.cursor < cr.length) { this.extend(cr[this.cursor++]!); continue }
        while (this.runs.length) this.closeRun(0)
        if (this.exits.length > MAX_EXITS) { this.overflow = true; this.exits = [] }
        const P = this.count
        this.revStart = new Int32Array(P + 1)
        for (let s = 0; s < P; s++) this.revStart[s + 1] = this.revStart[s]! + this.degree[s]!
        this.rev = new Int16Array(this.revStart[P]!); this.fill = this.revStart.slice(0, P)
        this.charge(P + this.runs.length); this.phase = 'reverse'; this.cursor = 0
      } else if (this.phase === 'reverse') {
        if (this.cursor === this.count) {
          this.fields = new Uint16Array(this.exits.length * this.count).fill(UNREACHED)
          this.phase = 'fields'; this.charge(Math.ceil(this.fields.length / 64)); this.field = 0; this.seed(); continue
        }
        const s = this.cursor++
        for (let d = 0; d < 4; d++) { const t = this.next[s * 4 + d]!; if (t >= 0) this.rev[this.fill[t]!++] = s }
      } else if (this.phase === 'fields') {
        if (this.field === this.exits.length) { this.phase = 'done'; this.done = true; break }
        const P = this.count, f = this.field * P
        if (this.expanding < 0) {
          if (!this.heap.size) { this.field++; this.seed(); continue }
          const g = this.heap.peekF(), s = this.heap.pop()
          if (g === this.fields[f + s]) { this.expanding = s; this.edge = this.revStart[s]! }
          continue
        }
        const s = this.expanding
        if (this.edge === this.revStart[s + 1]) { this.expanding = -1; used--; this.counts.fields--; continue }
        const src = this.rev[this.edge++]!, g = Math.min(UNREACHED - 1, this.fields[f + s]! + this.cost(src, s))
        if (g < this.fields[f + src]!) { this.fields[f + src] = g; this.heap.push(src, g, 0) }
      }
    }
    return Math.ceil(used / BUILD_WEIGHT)
  }
  private sortCrossings(): void {
    const n = this.crossings.length
    this.charge(n ? n * Math.ceil(Math.log2(n + 1)) : 0)
    this.crossings.sort((a, b) => a.d - b.d || a.target - b.target || a.along - b.along || a.across - b.across || a.sy - b.sy || a.ty - b.ty)
  }
  /**
   * Adds a crossing to an open run of the same face and target whose last crossing is its neighbour across the face,
   * with edges both ways between their sources and between their targets: every crossing of a run then reaches its
   * representative and back, on both sides, so one exit per run keeps reachability exact.
   */
  private extend(c: Crossing): void {
    const runs = this.runs, first = runs[0]?.[0]
    if (first && (first.d !== c.d || first.target !== c.target || first.along !== c.along)) while (runs.length) this.closeRun(0)
    for (let i = 0; i < runs.length;) { if (runs[i]!.at(-1)!.across < c.across - 1) this.closeRun(i); else i++ }
    const up = c.d < 2 ? 2 : 0, down = up + 1
    const run = runs.find(r => {
      const last = r.at(-1)!
      return last.across === c.across - 1 && this.next[last.slot * 4 + up] === c.slot && this.next[c.slot * 4 + down] === last.slot
        && this.nav.neighbor(last.to, up) === c.to && this.nav.neighbor(c.to, down) === last.to
    })
    if (run) run.push(c); else runs.push([c])
    const full = runs.findIndex(r => r.length === RUN)
    if (full >= 0) this.closeRun(full)
  }
  private closeRun(i: number): void {
    const run = this.runs.splice(i, 1)[0]!, c = run[Math.floor(run.length / 2)]!
    this.exits.push({ from: this.poses[c.slot]!, to: c.to, cost: c.cost, target: c.target })
  }
  private seed(): void {
    if (this.field >= this.exits.length) return
    const s = this.slots[localOf(this.nav.port.layout, this.exits[this.field]!.from)]!
    this.fields[this.field * this.count + s] = 0; this.heap.clear(); this.heap.push(s, 0, 0); this.expanding = -1
  }
  /** The built region; the same record for every query that shared this build. */
  result(): Region {
    if (!this.done) throw new Error('region build is not done')
    if (this.built) return this.built
    const r: Region = { index: this.index, epoch: this.epoch, slots: this.slots, poses: this.poses, next: this.next, exits: this.exits, fields: this.fields, overflow: this.overflow, sources: this.sources, bytes: 0 }
    r.bytes = r.slots.byteLength + r.poses.byteLength + r.next.byteLength + r.fields.byteLength + r.exits.length * 32
    return this.built = r
  }
  mixState(mix: (n: number) => void): void {
    mix(this.index); mix(this.epoch); mix(this.debt); mix(PHASES.indexOf(this.phase)); mix(this.cursor); mix(this.count); mix(this.crossings.length); mix(this.runs.length); mix(this.exits.length); mix(this.sources)
    mix(this.field); mix(this.expanding); mix(this.edge); this.heap.mixState(mix)
  }
}

/** Cost from a pose (world index) inside the region to every exit; UNREACHED where not connected. */
export function exitCosts(region: Region, pose: number, layout: Layout): number[] {
  const slot = slotOf(region, pose, layout), P = region.poses.length
  return region.exits.map((_, e) => slot < 0 ? UNREACHED : region.fields[e * P + slot]!)
}

/** Reverse Dijkstra inside the region from a set of poses; returns cost per slot (UNREACHED elsewhere). */
export function reverseField(region: Region, targets: readonly number[], layout: Layout): Uint16Array {
  const P = region.poses.length, out = new Uint16Array(P).fill(UNREACHED), heap = new IdHeap()
  const rs = new Int32Array(P + 1)
  for (let s = 0; s < P; s++) for (let d = 0; d < 4; d++) { const t = region.next[s * 4 + d]!; if (t >= 0) rs[t + 1]!++ }
  for (let s = 0; s < P; s++) rs[s + 1]! += rs[s]!
  const rev = new Int32Array(rs[P]!), fill = rs.slice(0, P)
  for (let s = 0; s < P; s++) for (let d = 0; d < 4; d++) { const t = region.next[s * 4 + d]!; if (t >= 0) rev[fill[t]!++] = s }
  for (const p of targets) { const s = slotOf(region, p, layout); if (s >= 0 && out[s] !== 0) { out[s] = 0; heap.push(s, 0, 0) } }
  while (heap.size) {
    const g = heap.peekF(), s = heap.pop()
    if (g !== out[s]) continue
    for (let i = rs[s]!; i < rs[s + 1]!; i++) {
      const src = rev[i]!, c = Math.min(UNREACHED - 1, g + edgeCost(layout, region.poses[src]!, region.poses[s]!))
      if (c < out[src]!) { out[src] = c; heap.push(src, c, 0) }
    }
  }
  return out
}

/** Region records by tile, in insertion order; stale records are dropped on read, the oldest evicted past the byte cap. */
export class RegionStore {
  private readonly nav: NavigationSystem
  private readonly maxBytes: number
  private readonly regions = new Map<number, Region>()
  private total = 0
  constructor(nav: NavigationSystem, maxBytes = 32 * 1024 * 1024) { this.nav = nav; this.maxBytes = maxBytes }
  get bytes(): number { return this.total }
  get size(): number { return this.regions.size }
  get(index: number): Region | undefined {
    const r = this.regions.get(index)
    if (!r) return undefined
    if (r.epoch === this.nav.revisions[index]) return r
    this.regions.delete(index); this.total -= r.bytes
    return undefined
  }
  put(region: Region): void {
    const old = this.regions.get(region.index)
    if (old) { this.regions.delete(region.index); this.total -= old.bytes }
    this.regions.set(region.index, region); this.total += region.bytes
    while (this.total > this.maxBytes && this.regions.size > 1) {
      const [index, r] = this.regions.entries().next().value!
      this.regions.delete(index); this.total -= r.bytes
    }
  }
  clear(): void { this.regions.clear(); this.total = 0 }
}
