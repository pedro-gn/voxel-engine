import type { Layout } from '../../world/layout.ts'
import { edgeCost, type NavigationSystem } from './navigation.ts'
import { IdHeap } from './heap.ts'

export const UNREACHED = 0xffff
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
interface Crossing { slot: number; d: number; to: number; cost: number; target: number; sy: number; ty: number; along: number; across: number }
type Phase = 'poses' | 'edges' | 'exits' | 'reverse' | 'fields' | 'done'
const PHASES: readonly Phase[] = ['poses', 'edges', 'exits', 'reverse', 'fields', 'done']

/** Builds a Region in slices, one operation per cell, edge, crossing, pop or relaxation; restarts if its tile changes. */
export class RegionBuild {
  readonly index: number
  done = false
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
  private runs: Crossing[] = []
  private fields = new Uint16Array(0)
  private overflow = false
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
  private restart(): void {
    this.epoch = this.nav.revisions[this.index]!; this.phase = 'poses'; this.cursor = 0; this.count = 0
    this.slots = new Int16Array(4096).fill(-1); this.crossings = []; this.exits = []; this.runs = []; this.overflow = false
    this.heap.clear(); this.field = 0; this.expanding = -1; this.edge = 0
  }
  private cost(a: number, b: number): number { const ya = this.locals[a]! >> 8, yb = this.locals[b]! >> 8; return 4 + (yb > ya ? 2 : ya - yb) }
  step(cap: number): number {
    let used = 0
    if (this.done) return 0
    if (this.nav.revisions[this.index] !== this.epoch) this.restart()
    const L = this.nav.port.layout, [ox, oy, oz] = this.origin
    while (used < cap && !this.done) {
      used++
      if (this.phase === 'poses') {
        const c = this.cursor++, x = ox + (c & 15), z = oz + ((c >> 4) & 15), y = oy + (c >> 8)
        if (this.nav.stand(x, y, z)) { this.slots[c] = this.count; this.locals[this.count++] = c }
        if (this.cursor === 4096) {
          const P = this.count
          this.poses = new Int32Array(P); this.next = new Int16Array(P * 4).fill(-1); this.degree = new Int32Array(P)
          for (let s = 0; s < P; s++) { const l = this.locals[s]!; this.poses[s] = L.voxelIndex(ox + (l & 15), oy + (l >> 8), oz + ((l >> 4) & 15)) }
          this.phase = 'edges'; this.cursor = 0
        }
      } else if (this.phase === 'edges') {
        if (this.cursor === this.count * 4) { this.phase = 'exits'; this.cursor = 0; this.sortCrossings(); continue }
        const slot = this.cursor >> 2, d = this.cursor & 3, pose = this.poses[slot]!, to = this.nav.neighbor(pose, d)
        this.cursor++
        if (to < 0) continue
        const target = this.nav.tileOfPose(to)
        if (target === this.index) { const t = this.slots[localOf(L, to)]!; this.next[slot * 4 + d] = t; this.degree[t]!++; continue }
        const [fx, fy, fz] = L.voxelCoords(pose), ty = L.voxelCoords(to)[1]
        this.crossings.push({ slot, d, to, cost: edgeCost(L, pose, to), target, sy: fy, ty, along: d < 2 ? fx : fz, across: d < 2 ? fz : fx })
      } else if (this.phase === 'exits') {
        const cr = this.crossings
        if (this.cursor < cr.length) {
          const c = cr[this.cursor++]!, last = this.runs.at(-1)
          if (last && (this.runs.length === RUN || c.d !== last.d || c.target !== last.target || c.sy !== last.sy || c.ty !== last.ty || c.along !== last.along || c.across !== last.across + 1)) this.closeRun()
          this.runs.push(c)
          continue
        }
        if (this.runs.length) this.closeRun()
        if (this.exits.length > MAX_EXITS) { this.overflow = true; this.exits = [] }
        const P = this.count
        this.revStart = new Int32Array(P + 1)
        for (let s = 0; s < P; s++) this.revStart[s + 1] = this.revStart[s]! + this.degree[s]!
        this.rev = new Int16Array(this.revStart[P]!); this.fill = this.revStart.slice(0, P)
        this.phase = 'reverse'; this.cursor = 0
      } else if (this.phase === 'reverse') {
        if (this.cursor === this.count) {
          this.fields = new Uint16Array(this.exits.length * this.count).fill(UNREACHED)
          this.phase = 'fields'; this.field = 0; this.seed(); continue
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
        if (this.edge === this.revStart[s + 1]) { this.expanding = -1; used--; continue }
        const src = this.rev[this.edge++]!, g = Math.min(UNREACHED - 1, this.fields[f + s]! + this.cost(src, s))
        if (g < this.fields[f + src]!) { this.fields[f + src] = g; this.heap.push(src, g, 0) }
      }
    }
    return used
  }
  private sortCrossings(): void {
    this.crossings.sort((a, b) => a.d - b.d || a.target - b.target || a.sy - b.sy || a.ty - b.ty || a.along - b.along || a.across - b.across)
  }
  private closeRun(): void {
    const c = this.runs[Math.floor(this.runs.length / 2)]!
    this.exits.push({ from: this.poses[c.slot]!, to: c.to, cost: c.cost, target: c.target }); this.runs = []
  }
  private seed(): void {
    if (this.field >= this.exits.length) return
    const s = this.slots[localOf(this.nav.port.layout, this.exits[this.field]!.from)]!
    this.fields[this.field * this.count + s] = 0; this.heap.clear(); this.heap.push(s, 0, 0); this.expanding = -1
  }
  result(): Region {
    if (!this.done) throw new Error('region build is not done')
    const r: Region = { index: this.index, epoch: this.epoch, slots: this.slots, poses: this.poses, next: this.next, exits: this.exits, fields: this.fields, overflow: this.overflow, bytes: 0 }
    r.bytes = r.slots.byteLength + r.poses.byteLength + r.next.byteLength + r.fields.byteLength + r.exits.length * 32
    return r
  }
  mixState(mix: (n: number) => void): void {
    mix(this.index); mix(this.epoch); mix(PHASES.indexOf(this.phase)); mix(this.cursor); mix(this.count); mix(this.crossings.length); mix(this.runs.length); mix(this.exits.length)
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
