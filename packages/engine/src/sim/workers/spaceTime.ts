import type { ReservationTable } from './reservations.ts'

export interface SpaceTimePort {
  /** NavigationSystem.neighbor: the pose reached by planar direction d, or -1. */
  neighbor(p: number, d: number): number
  /** Live pose policy for this unit. */
  allowed(p: number): boolean
  /** Body cells standing on pose p. */
  cellsOf(p: number): number[]
  /** Union of body cells over a step a→b. */
  stepCells(a: number, b: number): number[]
  /** Ticks a step a→b takes: 4 flat, 4 + 2 climb, 4 + d drop. */
  ticksOf(a: number, b: number): number
  coords(p: number): [number, number, number]
}
/** steps[i]: stand on `pose` through tick `until`, then take the next step. rejoin indexes `targets`, -1 for a pocket. */
export interface SpaceTimePlan { steps: { pose: number; until: number }[]; rejoin: number }
export type SpaceTimeStatus = 'pending' | 'found' | 'failed'
const STATUSES: readonly SpaceTimeStatus[] = ['pending', 'found', 'failed']
/** Extra cost per tick on a pose with room to its right. */
const LANE_COST = 1

/**
 * A* over (pose, tick) inside a box around the start, against another owners' reservations. Every state's cost is
 * the ticks elapsed; the heuristic adds the estimated walk to the end of `targets`. The search ends on the last
 * target, or at the window's end on any pose (a target there rejoins the route, any other pose is a pocket, valid only
 * if no one else has its cells for the rest of the table's horizon). With a
 * `refuge` predicate it ends only at the window's end on a refuge pose: a way out of someone else's route.
 */
export class SpaceTimeSearch {
  status: SpaceTimeStatus = 'pending'
  plan: SpaceTimePlan | null = null
  /** Operations spent: one per pop and one per action tried. */
  ops = 0
  private readonly port: SpaceTimePort
  private readonly table: ReservationTable
  private readonly owner: number
  private readonly start: number
  private readonly startTick: number
  private readonly targets: readonly number[]
  private readonly radius: number
  private readonly maxOps: number
  private readonly refuge?: (p: number) => boolean
  private readonly avoid?: (p: number) => boolean
  private readonly end: number
  private readonly origin: [number, number, number]
  private readonly targetCoords: [number, number, number][]
  private readonly ids = new Map<number, number>()
  private poses: number[] = []
  private ticks: number[] = []
  private gs: number[] = []
  private hs: number[] = []
  /** Planar direction to the right of the route's heading, or -1 without targets. */
  private readonly right: number
  private readonly lanes = new Map<number, number>()
  private parents: number[] = []
  private heap: number[] = []
  private expanding = -1
  /** 0 is the wait, 1..4 the planar steps. */
  private action = 0
  constructor(port: SpaceTimePort, table: ReservationTable, owner: number, start: number, startTick: number, targets: readonly number[], radius = 8, maxOps = 4096, refuge?: (p: number) => boolean, avoid?: (p: number) => boolean) {
    this.port = port; this.table = table; this.owner = owner; this.start = start; this.startTick = startTick; this.targets = targets
    this.radius = radius; this.maxOps = maxOps; this.refuge = refuge; this.avoid = avoid; this.end = startTick + table.window
    this.origin = port.coords(start); this.targetCoords = targets.map(p => port.coords(p))
    const last = this.targetCoords.at(-1), dx = last ? last[0] - this.origin[0] : 0, dz = last ? last[2] - this.origin[2] : 0
    // Right of (dx, dz) is (-dz, dx); directions index DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1].
    this.right = !dx && !dz ? -1 : Math.abs(dx) >= Math.abs(dz) ? dx > 0 ? 2 : 3 : dz > 0 ? 1 : 0
    this.add(start, startTick, -1, 0)
  }
  private h(p: number): number {
    if (!this.targets.length) return 0
    const [x, , z] = this.port.coords(p), n = this.targets.length
    let h = Infinity
    for (let i = 0; i < n; i++) { const c = this.targetCoords[i]!; h = Math.min(h, 4 * (Math.abs(x - c[0]) + Math.abs(z - c[2])) + 4 * (n - 1 - i)) }
    return h
  }
  private f(id: number): number { return this.gs[id]! + this.hs[id]! }
  /**
   * Keep right: one extra per tick spent on a pose with a walkable pose to its right, so in a passage opposing flows
   * take separate lanes. In the open every pose pays it alike.
   */
  private lane(p: number): number {
    if (this.right < 0) return 0
    let v = this.lanes.get(p)
    if (v === undefined) { const q = this.port.neighbor(p, this.right); v = q >= 0 && this.port.allowed(q) ? LANE_COST : 0; this.lanes.set(p, v) }
    return v
  }
  /** Lower f first, then more progress (lower h), then the lower pose: a total order, so ties never depend on insertion. */
  private less(a: number, b: number): boolean {
    const fa = this.f(a), fb = this.f(b)
    return fa < fb || fa === fb && (this.hs[a]! < this.hs[b]! || this.hs[a] === this.hs[b] && this.poses[a]! < this.poses[b]!)
  }
  private add(p: number, t: number, parent: number, g: number): void {
    const key = p * (this.table.window + 1) + (t - this.startTick)
    if (this.ids.has(key)) return
    const id = this.poses.length
    this.ids.set(key, id); this.poses.push(p); this.ticks.push(t); this.gs.push(g); this.hs.push(this.h(p)); this.parents.push(parent)
    let i = this.heap.length
    this.heap.push(id)
    while (i) { const q = (i - 1) >> 1; if (!this.less(this.heap[i]!, this.heap[q]!)) break; [this.heap[i], this.heap[q]] = [this.heap[q]!, this.heap[i]!]; i = q }
  }
  private pop(): number {
    const top = this.heap[0]!, last = this.heap.pop()!
    if (this.heap.length) {
      this.heap[0] = last
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= this.heap.length) break
        if (c + 1 < this.heap.length && this.less(this.heap[c + 1]!, this.heap[c]!)) c++
        if (!this.less(this.heap[c]!, this.heap[i]!)) break
        ;[this.heap[i], this.heap[c]] = [this.heap[c]!, this.heap[i]!]; i = c
      }
    }
    return top
  }
  /**
   * A pocket is stood on after the window: nobody else may have its cells for the rest of the table's horizon, and it
   * must not be a pose the caller asks to avoid (another unit's destination).
   */
  private holdable(p: number): boolean {
    if (this.avoid?.(p)) return false
    const cells = this.port.cellsOf(p)
    for (let t = this.end + 1; t < this.table.now + 2 * this.table.window; t++) if (!this.table.free(this.owner, t, cells)) return false
    return true
  }
  private inBox(q: number): boolean {
    const [x, y, z] = this.port.coords(q), [ox, oy, oz] = this.origin
    return Math.abs(x - ox) <= this.radius && Math.abs(z - oz) <= this.radius && Math.abs(y - oy) <= 4
  }
  private finish(id: number): void {
    const chain: number[] = []
    for (let i = id; i >= 0; i = this.parents[i]!) chain.push(i)
    chain.reverse()
    const steps: { pose: number; until: number }[] = []
    for (const i of chain) {
      const last = steps.at(-1)
      if (last && last.pose === this.poses[i]) last.until = this.ticks[i]!
      else steps.push({ pose: this.poses[i]!, until: this.ticks[i]! })
    }
    const p = this.poses[id]!
    this.plan = { steps, rejoin: this.targets.lastIndexOf(p) }
    this.status = 'found'
  }
  /** Operations left before the search gives up. */
  get remaining(): number { return Math.max(0, this.maxOps - this.ops) }
  /** Spends at most `cap` operations; returns how many it used. */
  step(cap: number): number {
    let used = 0
    while (used < cap && this.status === 'pending') {
      if (this.ops >= this.maxOps) { this.status = 'failed'; break }
      used++; this.ops++
      if (this.expanding < 0) {
        if (!this.heap.length) { this.status = 'failed'; break }
        const id = this.pop(), p = this.poses[id]!, t = this.ticks[id]!
        if (t >= this.end ? (this.refuge ? this.refuge(p) : true) && (this.targets.includes(p) || this.holdable(p)) : this.targets.length && p === this.targets.at(-1)) { this.finish(id); break }
        if (t >= this.end) continue
        this.expanding = id; this.action = 0
        continue
      }
      const id = this.expanding, p = this.poses[id]!, t = this.ticks[id]!
      if (this.action === 0) {
        if (this.table.free(this.owner, t + 1, this.port.cellsOf(p))) this.add(p, t + 1, id, this.gs[id]! + 1 + this.lane(p))
      } else {
        const q = this.port.neighbor(p, this.action - 1)
        if (q >= 0 && this.inBox(q) && this.port.allowed(q)) {
          const k = this.port.ticksOf(p, q)
          if (t + k <= this.end) {
            const cells = this.port.stepCells(p, q)
            let ok = true
            for (let i = 1; i <= k && ok; i++) ok = this.table.free(this.owner, t + i, cells)
            if (ok) this.add(q, t + k, id, this.gs[id]! + k * (1 + this.lane(q)))
          }
        }
      }
      if (++this.action === 5) this.expanding = -1
    }
    return used
  }
  mixState(mix: (n: number) => void): void {
    mix(STATUSES.indexOf(this.status)); mix(this.ops); mix(this.owner); mix(this.start); mix(this.startTick); mix(this.radius); mix(this.maxOps); mix(this.refuge ? 1 : 0)
    mix(this.targets.length); for (const p of this.targets) mix(p)
    mix(this.expanding); mix(this.action)
    mix(this.poses.length)
    for (let i = 0; i < this.poses.length; i++) { mix(this.poses[i]!); mix(this.ticks[i]!); mix(this.gs[i]!); mix(this.parents[i]!) }
    mix(this.heap.length); for (const id of this.heap) mix(id)
    mix(this.plan ? this.plan.steps.length : -1)
    if (this.plan) { for (const s of this.plan.steps) { mix(s.pose); mix(s.until) } mix(this.plan.rejoin) }
  }
}
