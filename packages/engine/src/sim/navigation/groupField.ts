import type { NavigationSystem, PathStatus } from './navigation.ts'
import { IdHeap } from './heap.ts'
import { SOURCES, UNREACHED, exitKey, reverseField, slotOf, splitKey, type Region, type RegionStore } from './regions.ts'
import { ROUTE_WEIGHT, RegionReader } from './routeSearch.ts'

const STATUSES: readonly PathStatus[] = ['pending', 'found', 'unreachable', 'limited', 'stale', 'cancelled']
type Phase = 'seed' | 'search' | 'validate'
const PHASES: readonly Phase[] = ['seed', 'search', 'validate']

/**
 * Reverse weighted abstract A* (ROUTE_WEIGHT) from a destination over region exits, shared by every unit of a move order. D(exit) is the cost
 * from the exit's `from` pose to the nearest goal; each start is a node of its own, settled when popped. The heuristic
 * is the flat one from the nearest box of starts (one per start tile), so the search grows toward the group instead of
 * in every direction. Source tiles are read only when their mask says they may step into the expanded region.
 */
export class GroupField {
  private readonly nav: NavigationSystem
  private readonly reader: RegionReader
  private readonly goals: readonly number[]
  private readonly starts: readonly number[]
  private readonly maxNodes: number
  private readonly weight: number
  private readonly goalRegions = new Map<number, number[]>()
  /** Start indices by region, and per start region the box of its starts (min x, z, max x, y, z) for the heuristic. */
  private readonly startRegions = new Map<number, number[]>()
  private readonly boxes: number[][]
  private readonly startBase: number
  status: PathStatus = 'pending'
  spent = 0
  readonly estimate: number
  readonly goalFields = new Map<number, Uint16Array>()
  private readonly heap = new IdHeap()
  private readonly d = new Map<number, number>()
  private readonly closed = new Set<number>()
  /** Exits of a region grouped by target region, built when the region is first read. */
  private readonly into = new Map<number, Map<number, number[]>>()
  private settled = 0
  private phase: Phase = 'seed'
  private seedCursor = 0
  private seedSource = 0
  private seededStarts = false
  private expanding = -1
  private source = 0
  private debt = 0
  private validation: Iterator<[number, number]> | null = null
  private validateRevision = 0
  private validationProgress = 0
  constructor(nav: NavigationSystem, store: RegionStore, goals: readonly number[], starts: readonly number[], maxNodes = 32768, weight = ROUTE_WEIGHT) {
    this.nav = nav; this.reader = new RegionReader(nav, store); this.goals = goals; this.starts = starts; this.maxNodes = maxNodes; this.weight = weight
    const L = nav.port.layout
    for (const p of goals) { const r = nav.tileOfPose(p), list = this.goalRegions.get(r); if (list) list.push(p); else this.goalRegions.set(r, [p]) }
    const boxes = new Map<number, number[]>()
    starts.forEach((p, i) => {
      const r = nav.tileOfPose(p), list = this.startRegions.get(r), [x, y, z] = L.voxelCoords(p), box = boxes.get(r)
      if (list) list.push(i); else this.startRegions.set(r, [i])
      if (!box) boxes.set(r, [x, z, x, y, z])
      else { box[0] = Math.min(box[0]!, x); box[1] = Math.min(box[1]!, z); box[2] = Math.max(box[2]!, x); box[3] = Math.max(box[3]!, y); box[4] = Math.max(box[4]!, z) }
    })
    this.boxes = [...boxes.values()]
    this.startBase = 1 + nav.revisions.length * 4096
    // Lower bound from the goals' box: linear in starts + goals, where the exact minimum would be their product.
    const g0 = [Infinity, Infinity, Infinity], g1 = [-Infinity, -Infinity, -Infinity]
    for (const p of goals) L.voxelCoords(p).forEach((v, a) => { g0[a] = Math.min(g0[a]!, v); g1[a] = Math.max(g1[a]!, v) })
    let estimate = Infinity
    for (const s of starts) {
      const [x, y, z] = L.voxelCoords(s)
      estimate = Math.min(estimate, (Math.max(0, g0[0]! - x, x - g1[0]!) + Math.max(0, g0[2]! - z, z - g1[2]!)) * 4 + Math.max(0, g0[1]! - y) * 2)
    }
    this.estimate = estimate === Infinity ? 0 : estimate
    if (!goals.length || !starts.length) this.status = 'found'
  }
  get seen(): Map<number, number> { return this.reader.seen }
  /** The region record this field read for a tile (whatever its epoch now), so exit keys keep their meaning. */
  region(index: number): Region | undefined { return this.reader.regions.get(index) }
  get bytes(): number {
    let n = this.heap.size * 24 + this.d.size * 32 + this.closed.size * 16
    for (const f of this.goalFields.values()) n += f.byteLength
    return n
  }
  cancel(): void { this.status = 'cancelled'; this.reader.job = null }
  /** Cost to the goals from exit `key` (1 + region*4096 + e), or Infinity when unknown or unreachable. */
  distance(key: number): number { return this.d.get(key) ?? Infinity }
  /** The best exit key to take from `pose` (or -1 when the pose's region is a goal region and the goal field is best), and its total cost. */
  next(pose: number): { exit: number; cost: number } | null {
    const L = this.nav.port.layout, index = this.nav.tileOfPose(pose), r = this.reader.regions.get(index)
    if (!r) return null
    const slot = slotOf(r, pose, L)
    if (slot < 0) return null
    let best: { exit: number; cost: number } | null = null
    const gf = this.goalFields.get(index)?.[slot]
    if (gf !== undefined && gf !== UNREACHED) best = { exit: -1, cost: gf }
    const P = r.poses.length
    for (let e = 0; e < r.exits.length; e++) {
      const c = r.fields[e * P + slot]!, key = exitKey(index, e), d = this.d.get(key)
      if (c === UNREACHED || d === undefined) continue
      if (!best || c + d < best.cost) best = { exit: key, cost: c + d }
    }
    return best
  }
  /** Flat lower bound of the cost from the nearest start box to `p`; consistent, as a minimum of consistent bounds. */
  private h(p: number): number {
    const [x, y, z] = this.nav.port.layout.voxelCoords(p)
    let h = Infinity
    for (const [x0, z0, x1, y1, z1] of this.boxes) {
      const dx = Math.max(0, x0! - x, x - x1!), dz = Math.max(0, z0! - z, z - z1!)
      h = Math.min(h, (dx + dz) * 4 + Math.max(0, y - y1!) * 2)
    }
    return h === Infinity ? 0 : h
  }
  /** The region with its goal field and exit index, or undefined while it is being built. */
  private need(index: number): Region | undefined {
    const r = this.reader.need(index)
    if (!r) return undefined
    if (r.overflow) { this.status = 'limited'; return undefined }
    if (!this.into.has(index)) {
      const by = new Map<number, number[]>()
      r.exits.forEach((x, e) => { const list = by.get(x.target); if (list) list.push(e); else by.set(x.target, [e]) })
      this.into.set(index, by); this.debt += r.exits.length
      const goals = this.goalRegions.get(index)
      if (goals) { this.goalFields.set(index, reverseField(r, goals, this.nav.port.layout)); this.debt += r.poses.length * 5 }
    }
    return r
  }
  /** Tile index of source k of region `index`, or -1 when out of bounds or the region cannot be entered from it. */
  private source3(index: number, k: number): number {
    if (!(this.reader.regions.get(index)!.sources & (1 << k))) return -1
    const tx = this.nav.port.layout.size[0] >> 4, tz = this.nav.port.layout.size[2] >> 4, ty = this.nav.port.layout.size[1] >> 4
    const x = index % tx, z = Math.floor(index / tx) % tz, y = Math.floor(index / (tx * tz)), [dx, dy, dz] = SOURCES[k]!
    const sx = x + dx, sy = y + dy, sz = z + dz
    return sx < 0 || sy < 0 || sz < 0 || sx >= tx || sy >= ty || sz >= tz ? -1 : sx + sz * tx + sy * tx * tz
  }
  private push(key: number, d: number, at: number): void {
    const old = this.d.get(key)
    if (old !== undefined && old <= d) return
    if (old === undefined && this.d.size >= this.maxNodes) { this.status = 'limited'; return }
    this.d.set(key, d)
    if (key >= this.startBase) { this.heap.push(key, d, 0); return }
    const h = this.h(at) * this.weight; this.heap.push(key, d + h, h)
    // A start in the exit's region may now reach the goals through it.
    const [region, e] = splitKey(key), starts = this.startRegions.get(region)
    if (!starts) return
    const r = this.reader.regions.get(region)!, P = r.poses.length, L = this.nav.port.layout
    for (const i of starts) {
      const slot = slotOf(r, this.starts[i]!, L), c = slot < 0 ? UNREACHED : r.fields[e * P + slot]!
      this.debt++
      if (c !== UNREACHED) this.push(this.startBase + i, c + d, -1)
    }
  }
  /** Relaxes every exit of region `source` that enters `region`, given the cost from each pose of `region` to the goals. */
  private relaxInto(source: Region, region: Region, cost: (slot: number) => number): void {
    const L = this.nav.port.layout
    for (const e of this.into.get(source.index)!.get(region.index) ?? []) {
      const x = source.exits[e]!, slot = slotOf(region, x.to, L), c = slot < 0 ? UNREACHED : cost(slot)
      this.debt++
      if (c !== UNREACHED) this.push(exitKey(source.index, e), x.cost + c, x.from)
      if (this.status !== 'pending') return
    }
  }
  step(cap: number): number {
    let used = 0
    while (used < cap && this.status === 'pending') {
      if (this.debt) { const pay = Math.min(this.debt, cap - used); this.debt -= pay; used += pay; continue }
      if (this.reader.stale) { this.status = 'stale'; break }
      if (this.reader.job) { used += this.reader.build(cap - used); continue }
      used++
      if (this.phase === 'seed') { this.seed(); continue }
      if (this.phase === 'validate') { this.validate(); continue }
      if (this.expanding >= 0) { this.expand(); continue }
      if (this.settled === this.starts.length || !this.heap.size) { this.phase = 'validate'; this.validateRevision = this.nav.revision; continue }
      const f = this.heap.peekF(), key = this.heap.pop()
      if (this.closed.has(key)) continue
      if (key >= this.startBase) { if (f === this.d.get(key)) { this.closed.add(key); this.settled++ }; continue }
      const [region, e] = splitKey(key), at = this.reader.regions.get(region)!.exits[e]!.from
      if (f !== this.d.get(key)! + this.h(at) * this.weight) continue
      this.closed.add(key); this.expanding = key; this.source = 0
    }
    this.spent += used
    return used
  }
  /** Goal regions: their goal fields seed the exits entering them, and the starts standing in them. */
  private seed(): void {
    const regions = [...this.goalRegions.keys()]
    if (this.seedCursor === regions.length) { this.phase = 'search'; return }
    const index = regions[this.seedCursor]!, r = this.need(index)
    if (!r) return
    const field = this.goalFields.get(index)!
    if (!this.seededStarts) {
      this.seededStarts = true
      const L = this.nav.port.layout
      for (const i of this.startRegions.get(index) ?? []) { const slot = slotOf(r, this.starts[i]!, L); this.debt++; if (slot >= 0 && field[slot] !== UNREACHED) this.push(this.startBase + i, field[slot]!, -1) }
    }
    while (this.seedSource < SOURCES.length && this.status === 'pending') {
      const si = this.source3(index, this.seedSource)
      const s = si < 0 ? undefined : this.need(si)
      if (si >= 0 && !s) return
      if (s) this.relaxInto(s, r, slot => field[slot]!)
      this.seedSource++
    }
    this.seedCursor++; this.seedSource = 0; this.seededStarts = false
  }
  /** Expanding exit e of region A: every exit entering A reaches the goals through e. */
  private expand(): void {
    const [index, e] = splitKey(this.expanding), r = this.reader.regions.get(index)!, d = this.d.get(this.expanding)!, P = r.poses.length
    while (this.source < SOURCES.length && this.status === 'pending') {
      const si = this.source3(index, this.source)
      const s = si < 0 ? undefined : this.need(si)
      if (si >= 0 && !s) return
      if (s) this.relaxInto(s, r, slot => { const c = r.fields[e * P + slot]!; return c === UNREACHED ? UNREACHED : c + d })
      this.source++
    }
    this.expanding = -1
  }
  private validate(): void {
    this.validation ??= this.reader.seen.entries()
    const next = this.validation.next()
    if (!next.done) { this.validationProgress++; if (this.nav.revisions[next.value[0]] !== next.value[1]) this.status = 'stale'; return }
    if (this.validateRevision !== this.nav.revision) { this.validateRevision = this.nav.revision; this.validation = null; this.validationProgress = 0; return }
    this.status = 'found'
  }
  mixState(mix: (n: number) => void): void {
    const numbers = (values: Iterable<number>) => { const a = [...values]; mix(a.length); for (const n of a) mix(n) }
    mix(STATUSES.indexOf(this.status)); mix(PHASES.indexOf(this.phase)); numbers(this.goals); numbers(this.starts); mix(this.maxNodes); mix(Math.round(this.weight * 1024))
    mix(this.spent); mix(this.debt); mix(this.settled); mix(this.seedCursor); mix(this.seedSource); mix(this.seededStarts ? 1 : 0); mix(this.expanding); mix(this.source)
    mix(this.validateRevision); mix(this.validation ? this.validationProgress : -1)
    this.reader.mixState(mix); this.heap.mixState(mix)
    mix(this.d.size); for (const [k, d] of this.d) { mix(k); mix(d) }
    numbers(this.closed)
  }
}
