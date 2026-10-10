import { edgeCost, type NavigationSystem, type PathResult, type PathStatus } from './navigation.ts'
import { IdHeap } from './heap.ts'
import { RegionBuild, UNREACHED, exitKey, reverseField, slotOf, splitKey, type Region, type RegionStore } from './regions.ts'

export interface RouteOptions { exclude?: ReadonlySet<number> /* exit.from poses not to use */; maxNodes?: number /* default 8192 */; weight?: number /* default ROUTE_WEIGHT */ }
/**
 * Heuristic weight of route and group searches. Rough surfaces tie A* across whole rectangles of regions (every step
 * costs about its Manhattan share), so an exact search builds ten times the regions; 1.25 bounds the abstract cost at
 * 1.25× its optimum and measured 3–7% over exact flat A* on an adversarial bumpy floor.
 */
export const ROUTE_WEIGHT = 1.25
const STATUSES: readonly PathStatus[] = ['pending', 'found', 'unreachable', 'limited', 'stale', 'cancelled']
type Phase = 'start' | 'search' | 'validate'
const PHASES: readonly Phase[] = ['start', 'search', 'validate']

/** Min over goals of the flat A* heuristic; consistent over region exits too, since their costs are real path costs. */
export function routeHeuristic(goals: readonly (readonly [number, number, number])[], x: number, y: number, z: number): number {
  let h = Infinity
  for (const [gx, gy, gz] of goals) h = Math.min(h, (Math.abs(x - gx) + Math.abs(z - gz)) * 4 + Math.max(0, gy - y) * 2)
  return h === Infinity ? 0 : h
}

/**
 * Regions read by an abstract search, built on demand into the shared store. Each read records the tile revision,
 * so a change before the search finishes ends it stale; a region is kept by reference for the search's lifetime.
 */
export class RegionReader {
  readonly nav: NavigationSystem
  readonly store: RegionStore
  readonly seen = new Map<number, number>()
  readonly regions = new Map<number, Region>()
  job: RegionBuild | null = null
  stale = false
  constructor(nav: NavigationSystem, store: RegionStore) { this.nav = nav; this.store = store }
  /** The region, or undefined while a build for it runs (step the job, then ask again). */
  need(index: number): Region | undefined {
    const known = this.regions.get(index)
    if (known) { if (known.epoch !== this.nav.revisions[index]) this.stale = true; return known }
    if (this.job?.index === index) return undefined
    const r = this.store.get(index)
    if (r) return this.adopt(r)
    this.job = new RegionBuild(this.nav, index)
    return undefined
  }
  private adopt(r: Region): Region {
    const read = this.seen.get(r.index)
    if (read !== undefined && read !== r.epoch) this.stale = true
    this.seen.set(r.index, r.epoch); this.regions.set(r.index, r); return r
  }
  /** Steps the pending build; returns operations used. */
  build(cap: number): number {
    const job = this.job!, used = job.step(cap)
    if (job.done) { const r = job.result(); this.store.put(r); this.adopt(r); this.job = null }
    return used
  }
  mixState(mix: (n: number) => void): void {
    mix(this.seen.size); for (const [ti, rev] of this.seen) { mix(ti); mix(rev) }
    mix(this.job ? 1 : 0); this.job?.mixState(mix); mix(this.stale ? 1 : 0)
  }
}

/** Weighted abstract A* over region exits: exact in-region fields, one representative crossing per run. */
export class RouteSearch {
  private readonly nav: NavigationSystem
  private readonly reader: RegionReader
  private readonly start: number
  private readonly goals: readonly number[]
  private readonly goalCoords: [number, number, number][]
  private readonly goalRegions = new Map<number, number[]>()
  private readonly exclude?: ReadonlySet<number>
  private readonly maxNodes: number
  private readonly weight: number
  status: PathStatus = 'pending'
  cost = 0
  spent = 0
  readonly estimate: number
  /** After 'found': the exits to take, in order (the `from` poses), then the goal pose that the last segment reaches. */
  exits: number[] = []
  /** The exit keys behind `exits`, in the same order. */
  keys: number[] = []
  goal = -1
  /** Per-query goal fields, keyed by region index: cost from a region slot to the nearest goal. */
  readonly goalFields = new Map<number, Uint16Array>()
  private readonly heap = new IdHeap()
  private readonly g = new Map<number, number>()
  private readonly parent = new Map<number, number>()
  private readonly closed = new Set<number>()
  private bestGoal = Infinity
  private bestParent = -1
  private phase: Phase = 'start'
  /** Exit key being expanded and the next exit of its target region to relax. */
  private expanding = -1
  private relax = 0
  /** Operations owed by synchronous work (goal fields, reconstruction), paid before anything else. */
  private debt = 0
  /** Whether an exclusion skipped an exit: an exhausted search then proves nothing. */
  private cut = false
  private validation: Iterator<[number, number]> | null = null
  private validateRevision = 0
  private validationProgress = 0
  constructor(nav: NavigationSystem, store: RegionStore, start: number, goals: readonly number[], options?: RouteOptions) {
    this.nav = nav; this.reader = new RegionReader(nav, store); this.start = start; this.goals = goals
    this.exclude = options?.exclude; this.maxNodes = options?.maxNodes ?? 8192; this.weight = options?.weight ?? ROUTE_WEIGHT
    const L = nav.port.layout
    this.goalCoords = goals.map(p => L.voxelCoords(p))
    for (const p of goals) { const r = nav.tileOfPose(p), list = this.goalRegions.get(r); if (list) list.push(p); else this.goalRegions.set(r, [p]) }
    this.estimate = this.h(start)
    if (!goals.length || !nav.stand(...L.voxelCoords(start))) this.status = 'unreachable'
  }
  get seen(): Map<number, number> { return this.reader.seen }
  /** The region record this search read for a tile (whatever its epoch now), so exit keys keep their meaning. */
  region(index: number): Region | undefined { return this.reader.regions.get(index) }
  get bytes(): number {
    let n = this.heap.size * 24 + this.g.size * 48 + this.closed.size * 16
    for (const f of this.goalFields.values()) n += f.byteLength
    return n
  }
  cancel(): void { this.status = 'cancelled'; this.reader.job = null }
  result(): PathResult { return { status: this.status, path: this.exits, cost: this.cost } }
  private h(p: number): number { const [x, y, z] = this.nav.port.layout.voxelCoords(p); return routeHeuristic(this.goalCoords, x, y, z) }
  /** The region with its goal field computed, or undefined while it is being built. */
  private need(index: number): Region | undefined {
    const r = this.reader.need(index)
    if (!r) return undefined
    if (r.overflow) { this.status = 'limited'; return undefined }
    const goals = this.goalRegions.get(index)
    if (goals && !this.goalFields.has(index)) { this.goalFields.set(index, reverseField(r, goals, this.nav.port.layout)); this.debt += r.poses.length * 5 }
    return r
  }
  private push(key: number, g: number, parent: number, at: number): void {
    const old = this.g.get(key)
    if (old !== undefined && old <= g) return
    if (old === undefined && this.g.size >= this.maxNodes) { this.status = 'limited'; return }
    this.g.set(key, g); this.parent.set(key, parent); this.heap.push(key, g + this.h(at) * this.weight, this.h(at))
  }
  step(cap: number): number {
    let used = 0
    while (used < cap && this.status === 'pending') {
      if (this.debt) { const pay = Math.min(this.debt, cap - used); this.debt -= pay; used += pay; continue }
      if (this.reader.stale) { this.status = 'stale'; break }
      if (this.reader.job) { used += this.reader.build(cap - used); continue }
      if (this.phase === 'start') { used += this.begin(); continue }
      if (this.phase === 'validate') { used++; this.validate(); continue }
      if (this.expanding >= 0) { used += this.expand(cap - used); continue }
      used++
      if (this.bestParent >= 0 && this.bestGoal <= this.heap.peekF()) { this.reconstruct(); continue }
      if (!this.heap.size) { this.phase = 'validate'; this.validateRevision = this.nav.revision; continue }
      const f = this.heap.peekF(), key = this.heap.pop()
      if (this.closed.has(key) || f !== this.g.get(key)! + this.h(this.exitOf(key).to) * this.weight) continue
      this.closed.add(key); this.expanding = key; this.relax = 0
    }
    this.spent += used
    return used
  }
  private exitOf(key: number) { const [r, e] = splitKey(key); return this.reader.regions.get(r)!.exits[e]! }
  private begin(): number {
    const L = this.nav.port.layout, index = this.nav.tileOfPose(this.start), r = this.need(index)
    if (!r) return 0
    const slot = slotOf(r, this.start, L), P = r.poses.length
    if (slot < 0) { this.status = 'unreachable'; return 1 }
    r.exits.forEach((x, e) => {
      const c = r.fields[e * P + slot]!
      if (c === UNREACHED) return
      if (this.exclude?.has(x.from)) { this.cut = true; return }
      this.push(exitKey(index, e), c + x.cost, 0, x.to)
    })
    const gf = this.goalFields.get(index)?.[slot]
    if (gf !== undefined && gf !== UNREACHED) { this.bestGoal = gf; this.bestParent = 0 }
    this.phase = 'search'; this.debt += r.exits.length
    return 1
  }
  /** Relaxes the exits of the region entered by `expanding`, one operation each. */
  private expand(cap: number): number {
    const at = this.exitOf(this.expanding), index = at.target, r = this.need(index)
    if (!r) return 0
    const L = this.nav.port.layout, slot = slotOf(r, at.to, L), P = r.poses.length, g = this.g.get(this.expanding)!
    if (slot < 0) { this.expanding = -1; return 1 }
    if (this.relax === 0) {
      const gf = this.goalFields.get(index)?.[slot]
      if (gf !== undefined && gf !== UNREACHED && g + gf < this.bestGoal) { this.bestGoal = g + gf; this.bestParent = this.expanding }
    }
    let used = 0
    while (used < cap && this.relax < r.exits.length && this.status === 'pending') {
      const e = this.relax++, x = r.exits[e]!, c = r.fields[e * P + slot]!
      used++
      if (c === UNREACHED) continue
      if (this.exclude?.has(x.from)) { this.cut = true; continue }
      this.push(exitKey(index, e), g + c + x.cost, this.expanding, x.to)
    }
    if (this.relax === r.exits.length) { this.expanding = -1; if (!used) used = 1 }
    return used
  }
  private reconstruct(): void {
    const L = this.nav.port.layout, keys: number[] = []
    for (let k = this.bestParent; k > 0; k = this.parent.get(k)!) keys.push(k)
    keys.reverse()
    this.exits = keys.map(k => this.exitOf(k).from); this.keys = keys
    // The goal the last segment reaches: follow the goal field's first optimal step from the last entry pose.
    const last = keys.at(-1), index = last === undefined ? this.nav.tileOfPose(this.start) : this.exitOf(last).target
    const r = this.reader.regions.get(index)!, field = this.goalFields.get(index)!
    let slot = slotOf(r, last === undefined ? this.start : this.exitOf(last).to, L), steps = 0
    while (field[slot]! > 0) {
      let moved = false
      for (let d = 0; d < 4 && !moved; d++) {
        const t = r.next[slot * 4 + d]!
        if (t >= 0 && field[t]! + edgeCost(L, r.poses[slot]!, r.poses[t]!) === field[slot]) { slot = t; moved = true }
      }
      steps++
      if (!moved) break
    }
    this.goal = r.poses[slot]!; this.cost = this.bestGoal
    this.debt += keys.length + steps
    this.phase = 'validate'; this.validateRevision = this.nav.revision
  }
  private validate(): void {
    this.validation ??= this.reader.seen.entries()
    const next = this.validation.next()
    if (!next.done) { this.validationProgress++; if (this.nav.revisions[next.value[0]] !== next.value[1]) this.status = 'stale'; return }
    if (this.validateRevision !== this.nav.revision) { this.validateRevision = this.nav.revision; this.validation = null; this.validationProgress = 0; return }
    this.status = this.goal >= 0 ? 'found' : this.cut ? 'limited' : 'unreachable'
  }
  mixState(mix: (n: number) => void): void {
    const numbers = (values: Iterable<number>) => { const a = [...values]; mix(a.length); for (const n of a) mix(n) }
    mix(STATUSES.indexOf(this.status)); mix(PHASES.indexOf(this.phase)); mix(this.start); numbers(this.goals); mix(this.maxNodes); mix(Math.round(this.weight * 1024))
    numbers([...(this.exclude ?? [])].sort((a, b) => a - b))
    mix(this.cost); mix(this.spent); mix(this.debt); mix(this.cut ? 1 : 0); mix(this.expanding); mix(this.relax)
    mix(this.bestGoal === Infinity ? -1 : this.bestGoal); mix(this.bestParent); mix(this.validateRevision); mix(this.validation ? this.validationProgress : -1)
    this.reader.mixState(mix); this.heap.mixState(mix)
    mix(this.g.size); for (const [k, g] of this.g) { mix(k); mix(g); mix(this.parent.get(k)!) }
    numbers(this.closed); numbers(this.keys); mix(this.goal)
  }
}
