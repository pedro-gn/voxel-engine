import type { Layout } from '../../world/layout.ts'
import type { NavigationSystem, PathStatus } from './navigation.ts'
import { IdHeap } from './heap.ts'
import { SOURCES, UNREACHED, exitKey, reverseField, slotOf, splitKey, type Region, type RegionStore } from './regions.ts'
import { RegionReader, type RelaxedRecords } from './routeSearch.ts'
import { NO_COST, type LandmarkTables } from './landmarks.ts'

const STATUSES: readonly PathStatus[] = ['pending', 'found', 'unreachable', 'limited', 'stale', 'cancelled']
type Phase = 'seed' | 'search' | 'validate'
const PHASES: readonly Phase[] = ['seed', 'search', 'validate']
/**
 * Once a start is covered, the search stops when every open way costs more than FAR × the farthest covered start plus
 * FAR_SLACK: a start nothing reaches would otherwise make it exhaust the world. Starts left open still read next().
 */
const FAR = 1.5, FAR_SLACK = 512
/**
 * Heuristic weight of group fields. A field must reach every start of a cluster spread over a pad, so it expands far more
 * than one route; weight 2 halves or better its operations. Measured on the warm crowd world (25 fields of 20 clustered
 * starts against exact flat A*): mean 1.056, p95 1.23, reachability agreeing on all 500 starts. Routes keep ROUTE_WEIGHT.
 */
export const GROUP_WEIGHT = 2

/**
 * Splits a move's starts into clusters whose 16² columns lie within `reach` columns of one another, chained. One field
 * per cluster aims its heuristic at its own starts; one field for clusters far apart must expand everything cheaper
 * than its farthest start. Start indices per cluster, clusters in order of their first start.
 */
export function startClusters(starts: readonly number[], layout: Layout, reach = 2): number[][] {
  const columns = new Map<number, number>(), parent: number[] = [], at: [number, number][] = [], of = new Int32Array(starts.length)
  const root = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!; return i }
  const W = (layout.size[0] >> 4) + 1
  starts.forEach((p, i) => {
    const [x, , z] = layout.voxelCoords(p), cx = x >> 4, cz = z >> 4, key = cx + cz * W
    let c = columns.get(key)
    if (c === undefined) {
      c = parent.length; columns.set(key, c); parent.push(c); at.push([cx, cz])
      for (let dz = -reach; dz <= reach; dz++) for (let dx = -reach; dx <= reach; dx++) {
        const n = columns.get(cx + dx + (cz + dz) * W)
        if (n !== undefined && cx + dx >= 0 && cx + dx < W && n !== c) { const a = root(n), b = root(c); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b) }
      }
    }
    of[i] = c
  })
  const out = new Map<number, number[]>()
  starts.forEach((_, i) => { const r = root(of[i]!), list = out.get(r); if (list) list.push(i); else out.set(r, [i]) })
  return [...out.values()]
}

/**
 * Reverse weighted abstract A* (GROUP_WEIGHT) from a destination over region exits, shared by every unit of a move order. D(exit) is the cost
 * from the exit's `from` pose to the nearest goal. A start is covered once an exit of its region that it reaches is
 * closed; units read their own best exit at next() time, so starts are not search nodes and cost one operation each
 * when covered. The heuristic is the flat one from the nearest box of starts (one per start tile), so the search grows
 * toward the group instead of in every direction. Source tiles are read only when their mask says they may step into
 * the expanded region. With landmark tables (ALT) the heuristic is also the bound they give from the starts' cheapest
 * cost to a landmark, less the exit's own cost to it.
 *
 * `exhaust`: no starts, and the search runs until nothing is left to expand; `relaxed` reads the relaxed graph (poses on
 * falling blocks standable). The landmark tables are made this way.
 */
export interface GroupOptions { landmarks?: LandmarkTables | null; exhaust?: boolean; relaxed?: RelaxedRecords }
export class GroupField {
  private readonly nav: NavigationSystem
  private readonly reader: RegionReader
  readonly goals: readonly number[]
  private readonly starts: readonly number[]
  private readonly maxNodes: number
  private readonly weight: number
  private readonly exhaust: boolean
  /** Landmark tables, and per landmark the starts' lowest cost to it (NO_COST: the landmark is not used). */
  private readonly alt: LandmarkTables | null
  private readonly los: number[] = []
  private readonly goalRegions = new Map<number, number[]>()
  /** Start indices by region, and per start region the box of its starts (min x, z, max x, y, z) for the heuristic. */
  private readonly startRegions = new Map<number, number[]>()
  private readonly boxes: number[][]
  /** Debt per heuristic evaluation: one operation per 16 start boxes. */
  private readonly hCost: number
  /** Start indices not covered yet, by region. */
  private readonly open = new Map<number, number[]>()
  status: PathStatus = 'pending'
  spent = 0
  readonly estimate: number
  readonly goalFields = new Map<number, Uint16Array>()
  private readonly heap = new IdHeap()
  private readonly d = new Map<number, number>()
  private readonly closed = new Set<number>()
  /** Exits of a region grouped by target region, built when the region is first read. */
  private readonly into = new Map<number, Map<number, number[]>>()
  private covered = 0
  /** Cost of the farthest start covered so far. */
  private farthest = 0
  private phase: Phase = 'seed'
  private seedCursor = 0
  private seedSource = 0
  private expanding = -1
  private source = 0
  private debt = 0
  constructor(nav: NavigationSystem, store: RegionStore, goals: readonly number[], starts: readonly number[], maxNodes = 65536, weight = GROUP_WEIGHT, options?: GroupOptions) {
    this.nav = nav; this.reader = new RegionReader(nav, store, options?.relaxed); this.goals = goals; this.starts = starts; this.maxNodes = maxNodes; this.weight = weight
    this.exhaust = options?.exhaust ?? false
    this.alt = starts.length ? options?.landmarks === undefined ? nav.landmarks.current() : options.landmarks : null
    const L = nav.port.layout
    for (const p of goals) { const r = nav.tileOfPose(p), list = this.goalRegions.get(r); if (list) list.push(p); else this.goalRegions.set(r, [p]) }
    const boxes = new Map<number, number[]>()
    starts.forEach((p, i) => {
      const r = nav.tileOfPose(p), list = this.startRegions.get(r), [x, y, z] = L.voxelCoords(p), box = boxes.get(r)
      if (list) list.push(i); else this.startRegions.set(r, [i])
      if (!box) boxes.set(r, [x, z, x, y, z])
      else { box[0] = Math.min(box[0]!, x); box[1] = Math.min(box[1]!, z); box[2] = Math.max(box[2]!, x); box[3] = Math.max(box[3]!, y); box[4] = Math.max(box[4]!, z) }
    })
    this.boxes = [...boxes.values()]; this.hCost = (this.boxes.length >> 4) + (this.alt ? 1 : 0)
    if (this.alt) for (let k = 0; k < this.alt.count; k++) {
      // A start tile that reaches no landmark k bounds nothing: that landmark is left out for the whole field.
      let lo = Infinity
      for (const t of this.startRegions.keys()) { const c = this.alt.low(k, t); if (c === NO_COST) { lo = NO_COST; break } lo = Math.min(lo, c) }
      this.los.push(lo); this.debt += this.startRegions.size
    }
    for (const [r, list] of this.startRegions) this.open.set(r, [...list])
    for (const r of this.goalRegions.keys()) this.reader.pin(r)
    for (const r of this.startRegions.keys()) this.reader.pin(r)
    // Lower bound from the goals' box: linear in starts + goals, where the exact minimum would be their product.
    const g0 = [Infinity, Infinity, Infinity], g1 = [-Infinity, -Infinity, -Infinity]
    for (const p of goals) L.voxelCoords(p).forEach((v, a) => { g0[a] = Math.min(g0[a]!, v); g1[a] = Math.max(g1[a]!, v) })
    let estimate = Infinity
    for (const s of starts) {
      const [x, y, z] = L.voxelCoords(s)
      estimate = Math.min(estimate, (Math.max(0, g0[0]! - x, x - g1[0]!) + Math.max(0, g0[2]! - z, z - g1[2]!)) * nav.minStep + Math.max(0, g0[1]! - y) * nav.minClimb)
    }
    this.estimate = estimate === Infinity ? 0 : estimate
    if (!goals.length || !starts.length && !this.exhaust) this.status = 'found'
  }
  get seen(): Map<number, number> { return this.reader.seen }
  /** The region record this field read for a tile (whatever its epoch now), so exit keys keep their meaning. */
  region(index: number): Region | undefined { return this.reader.regions.get(index) }
  get bytes(): number {
    let n = this.heap.size * 24 + this.d.size * 32 + this.closed.size * 16
    for (const f of this.goalFields.values()) n += f.byteLength
    return n
  }
  /** Cancels a pending field; a settled one keeps its status, so callers can read it after their last unit leaves. */
  cancel(): void { if (this.status !== 'pending') return; this.status = 'cancelled'; this.reader.drop() }
  /** Every exit cost found so far, by key. */
  costs(): IterableIterator<[number, number]> { return this.d.entries() }
  /** Cost to the goals from exit `key` (1 + region*4096 + e), or Infinity when unknown or unreachable. */
  distance(key: number): number { return this.d.get(key) ?? Infinity }
  /** The same cost, as a corridor: from the exit's `from` pose to the nearest goal. */
  toGo(key: number): number { return this.d.get(key) ?? Infinity }
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
  /**
   * Lower bound of the cost from the nearest start to `p`, the `from` pose of exit `key`: the flat bound from the
   * nearest start box (consistent, as a minimum of consistent bounds), or the landmarks' when higher: a start costs at
   * least los[k] to landmark k, and from `p` the exit costs at most its table cost, so reaching `p` costs the difference.
   */
  private h(p: number, key: number): number {
    this.debt += this.hCost
    const [x, y, z] = this.nav.port.layout.voxelCoords(p)
    let h = Infinity
    for (const [x0, z0, x1, y1, z1] of this.boxes) {
      const dx = Math.max(0, x0! - x, x - x1!), dz = Math.max(0, z0! - z, z - z1!)
      h = Math.min(h, (dx + dz) * this.nav.minStep + Math.max(0, y - y1!) * this.nav.minClimb)
    }
    if (h === Infinity) h = 0
    const alt = this.alt
    if (alt) {
      const [index, e] = splitKey(key), r = this.reader.regions.get(index)!
      for (let k = 0; k < alt.count; k++) {
        const lo = this.los[k]!, up = lo === NO_COST ? NO_COST : alt.exit(k, r, e)
        if (up !== NO_COST) h = Math.max(h, lo - up)
      }
    }
    return h
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
    const h = this.h(at, key) * this.weight; this.heap.push(key, d + h, h)
  }
  /**
   * Covers the open starts of region `index` that reach `field` (an exit index, or a goal field over the region's
   * slots) at the cost it adds to `base`; a start that is no pose of the region has nothing more to learn either.
   */
  private cover(r: Region, field: number | Uint16Array, base: number): void {
    const list = this.open.get(r.index)
    if (!list) return
    const L = this.nav.port.layout, P = r.poses.length
    const left = list.filter(i => {
      const slot = slotOf(r, this.starts[i]!, L), c = slot < 0 ? 0 : typeof field === 'number' ? r.fields[field * P + slot]! : field[slot]!
      this.debt++
      if (c === UNREACHED) return true
      this.covered++; if (slot >= 0) this.farthest = Math.max(this.farthest, base + c)
      return false
    })
    if (left.length) this.open.set(r.index, left); else this.open.delete(r.index)
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
      if (this.reader.job) { used += this.reader.build(cap - used); continue }
      used++
      if (this.phase === 'seed') { this.seed(); continue }
      if (this.phase === 'validate') { this.validate(); continue }
      if (this.expanding >= 0) { this.expand(); continue }
      // The heap orders by d + weight × h, at most weight × (d + h): past weight × the far bound, every open way costs more.
      if (!this.exhaust && this.covered === this.starts.length || !this.heap.size || this.covered && this.heap.peekF() > this.weight * (this.farthest * FAR + FAR_SLACK)) { this.phase = 'validate'; continue }
      const f = this.heap.peekF(), key = this.heap.pop()
      if (this.closed.has(key)) continue
      const [region, e] = splitKey(key), r = this.reader.regions.get(region)!, at = r.exits[e]!.from
      if (f !== this.d.get(key)! + this.h(at, key) * this.weight) continue
      this.closed.add(key); this.expanding = key; this.source = 0
      this.cover(r, e, this.d.get(key)!)
    }
    this.spent += used
    // Settled: next() reads only the distances and the regions, so the frontier goes.
    if (this.status !== 'pending' && (this.heap.size || this.closed.size)) { this.heap.clear(); this.closed.clear(); this.reader.drop() }
    return used
  }
  /** Goal regions: their goal fields seed the exits entering them, and cover the starts standing in them. */
  private seed(): void {
    const regions = [...this.goalRegions.keys()]
    if (this.seedCursor === regions.length) { this.phase = 'search'; return }
    const index = regions[this.seedCursor]!, r = this.need(index)
    if (!r) return
    const field = this.goalFields.get(index)!
    if (this.seedSource === 0) this.cover(r, field, 0)
    while (this.seedSource < SOURCES.length && this.status === 'pending') {
      const si = this.source3(index, this.seedSource)
      const s = si < 0 ? undefined : this.need(si)
      if (si >= 0 && !s) return
      if (s) this.relaxInto(s, r, slot => field[slot]!)
      this.seedSource++
    }
    this.seedCursor++; this.seedSource = 0
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
  /**
   * Never stale: a field proves nothing (a start it misses plans its own route), and a unit standing in a region that
   * changed since the field read it prices its way on from the current record (nextHop), so the costs keep serving.
   */
  private validate(): void { this.status = 'found' }
  mixState(mix: (n: number) => void): void {
    const numbers = (values: Iterable<number>) => { const a = [...values]; mix(a.length); for (const n of a) mix(n) }
    mix(STATUSES.indexOf(this.status)); mix(PHASES.indexOf(this.phase)); numbers(this.goals); numbers(this.starts); mix(this.maxNodes); mix(Math.round(this.weight * 1024))
    mix(this.exhaust ? 1 : 0); mix(this.alt ? this.alt.geometry : -1); numbers(this.los)
    mix(this.spent); mix(this.debt); mix(this.covered); mix(this.farthest); mix(this.seedCursor); mix(this.seedSource); mix(this.expanding); mix(this.source)
    this.reader.mixState(mix); this.heap.mixState(mix)
    mix(this.d.size); for (const [k, d] of this.d) { mix(k); mix(d) }
    numbers(this.closed)
    mix(this.open.size); for (const [r, list] of this.open) { mix(r); numbers(list) }
  }
}
