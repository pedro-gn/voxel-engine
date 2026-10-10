import type { BlockRegistry } from '../../blocks/registry.ts'
import type { Layout } from '../../world/layout.ts'
import { voxelId } from '../../world/voxel.ts'
import { raycast } from '../../interact/raycast.ts'
import type { Command, Vec3 } from '../commands.ts'
import { NavigationSystem, type PathSearch } from '../navigation/navigation.ts'
import { EngineeringSearch, type RouteAction } from '../navigation/engineering.ts'
import { RouteSearch } from '../navigation/routeSearch.ts'
import { GroupField } from '../navigation/groupField.ts'
import { splitKey } from '../navigation/regions.ts'
import { descend } from '../navigation/refine.ts'
import { walkSweep } from './walkSweep.ts'
import { NO_CREW_TICKS, effectivePriority, parkChoice, shares } from './frontier.ts'
import { WORKER_STATES, type WorkerCommand, type WorkerOptions, type WorkerState, type WorkerTick, type WorkerView, type WorkBlockReason, type WorkOrderView } from './types.ts'

export interface WorkerPort {
  layout: Layout; registry: BlockRegistry
  get(x: number, y: number, z: number): number
  /** Allocation/preflight first; resource callback immediately after the grid write, before physics hooks. */
  edit(pos: Vec3, expected: number, value: number, commit: () => void): boolean
  safe(x: number, y: number, z: number): boolean
  hazard(x: number, y: number, z: number): boolean
  dynamicBusy(): boolean
  emit(type: string, payload: unknown): void
}
interface Unit {
  available: boolean
  validatedWorld: number; validatedPose: [number, number, number]
  workPoses: number[]
  allowDig: boolean; buildBlock: number; engineering: EngineeringSearch | null; searchLimited: boolean; actions: RouteAction[]; actionCursor: number; alternative: number[]; alternativeCost: number
  id: number; x: number; y: number; z: number; facing: number; state: WorkerState; tools: Set<string>; stock: Map<number, number>
  goal: number | null; search: PathSearch | null; path: number[]; cursor: number; task: Task | null; progress: number; duration: number
  cells: number[]
  /** area: the validated sweep of a flat step; each tick's conservative sweep is clipped to it, so grazing corners never abort a step. */
  motion: { from: number; to: number; cursor: number; start: [number, number, number]; flat: boolean; elapsed: number; ticks: number; cells: number[]; area: Set<number> | null } | null
  vy: number; wait: number; retry: number; revision: number; reason?: WorkBlockReason
  /** Build designations the unit started its current route inside; only these may be crossed on the way out. */
  escape: Order[]
  /** Consecutive ticks spent idle on a pose the unit may not stay on. */
  exposed: number
  /** Whether the stationary pose is one the unit may not stay on; refreshed with the stationary validation. */
  unsafeHere: boolean
  /** Consecutive stale searches; each one doubles the wait before the next attempt. */
  stale: number
  /** The tick of the last move or work progress; a task claim lapses LEASE_TICKS after it. */
  progressAt: number
  /** A hierarchical route being walked; its refined segments are appended to `path`, two ahead of the unit. */
  route: Route | null
  /** Region-confined flat search refining a segment that the field descent could not. */
  segment: PathSearch | null
}
/**
 * last: pose where the refined path ends; segs: refined segments by end index in `path`, with the region revision they
 * were refined on; exits: exit keys refined so far; next: next exit of a route search to refine; target: what `segment`
 * refines (an exit key, or -1 for the goal).
 */
interface Route {
  search: RouteSearch | GroupField; goals: number[]; exits: number[]; next: number; last: number
  segs: { end: number; region: number; epoch: number }[]; exclude: number[]; finished: boolean; replan: boolean
  target: { key: number; region: number; epoch: number } | null
}
interface Order extends Omit<WorkOrderView, 'effectivePriority'> {
  cursor: number; ids: Set<number> | null; priority: number; parked: number[]; parkedRevision: number
  /** The tick of the order's last progress (creation or a task done); its effective priority ages from here. */
  idleSince: number
  /** The tick since which no eligible unit could take the order's tasks; -1 while one can. */
  noCrewSince: number
  /**
   * Build only. Each layer is placed inside-out, ring by ring (ring 0 is the border), so an inner cell is reached from
   * unbuilt outer cells of the same layer. ringPending counts cells left per layer×ring; floor/ring are the current ones;
   * progress is the tick of the last placed cell. A layer that stalls falls back to reserving the whole box.
   */
  ringPending: Int32Array | null; rings: number; floor: number; ring: number; progress: number; stalled: boolean
}
/** A failure holds until the unit moves, the reservation policy changes, or a nav tile it depended on changes. */
interface TaskFailure { origin: number; policy: number; nav: number; tiles: ReadonlyMap<number, number>; retry: number; reason: WorkBlockReason }
interface Task { order: Order; i: number; pos: Vec3; p: number; expected: number; claim: number; added: number; reason?: WorkBlockReason; failures: Map<number, TaskFailure> }
const MAX_TASKS = 256, MAX_AREA = 1 << 20, MAX_PARKS = 16, MAX_FAILURES = 32, MAX_PARKED_FAILURES = 1024, STALL_TICKS = 200, LEASE_TICKS = 200
const WALK_SPEED = 64, WALK_LOOKAHEAD = 32, WALK_PROBES = 8
/** Flat heuristic estimate above which a unit walks a hierarchical route; steps one field descent may take. */
export const HIER_MIN = 48 * 4
const SEGMENT_STEPS = 256
const STATUSES = ['pending', 'found', 'unreachable', 'limited', 'stale', 'cancelled'] as const
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const
/** Ticks to wait after the n-th consecutive stale search: doubling, capped at 32 (and at a safe shift). */
export const staleBackoff = (n: number): number => Math.min(32, 1 << Math.min(5, n))
/** Exact ceil(sqrt(n)) for a nonnegative safe integer, independent of floating-point approximations. */
const ceilSqrt = (n: number): number => { let s = Math.floor(Math.sqrt(n)); while (s * s > n) s--; while (s * s < n) s++; return s }
/** Cells of a sx×sz layer at ring r or deeper. */
const inner = (sx: number, sz: number, r: number): number => Math.max(0, sx - 2 * r) * Math.max(0, sz - 2 * r)
/** Yields first, then the list second() builds, only if the consumer gets that far. */
function* chain<T>(first: readonly T[], second: () => readonly T[]): Generator<T> { yield* first; yield* second() }
const integer = (n: unknown, min: number, max = 0x7fffffff): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max

/** Authoritative units, work frontier, inventory and exclusive swept-volume reservations. */
export class WorkerSystem {
  readonly port: WorkerPort
  readonly nav: NavigationSystem
  readonly units = new Map<number, Unit>()
  private orders: Order[] = []
  /** Failure history of parked tasks by voxel, so a task returning to the frontier is not retried from scratch. */
  private parkedFailures = new Map<number, { reason: WorkBlockReason | undefined; failures: Map<number, TaskFailure> }>()
  /** Active build designations and their union box, refreshed whenever one starts or ends. */
  private reservations: Order[] = []
  private reservedMin: [number, number, number] = [0, 0, 0]
  private reservedMax: [number, number, number] = [-1, -1, -1]
  private tasks: Task[] = []
  /** Frontier tasks by chunk column, so an idle unit looks at nearby tasks first. Derived from tasks, not hashed. */
  private taskIndex = new Map<number, Task[]>()
  /** Frontier slots per order id, recomputed from hashed state at every expansion. */
  private share = new Map<number, number>()
  private targets = new Set<number>()
  private workPositions = new Map<number, number>()
  private occupied = new Map<number, number>()
  private occupiedColumns = new Map<number, Set<number>>()
  private loose = new Map<number, Map<number, number>>()
  private dirtyDrops = new Map<string, { pos: Vec3; block: number; count: number }>()
  private barriers: { unit: number; pos: Vec3 }[] = []
  private dirty = new Set<number>()
  private dig: Uint16Array
  private build: Uint16Array
  private drops: Uint16Array
  private tools: (string | undefined)[]
  private nextUnit = 1
  private nextOrder = 1
  private time = 0
  private assignmentCursor = 0
  private revision = 0
  private worldRevision = 0
  /** Bumped when reservations change, physics settles or the world is replaced: every task failure becomes retryable. */
  private policy = 0
  private mutations = 0
  private engineeringVisited = 0
  /** Operations spent this tick descending region fields; shares the navigation budget. */
  private refineWork = 0
  /** Units walking each group field, and the field's hash id in creation order. */
  private groups = new Map<GroupField, { id: number; users: number }>()
  private nextGroup = 1
  private dynamicWasBusy = false
  readonly maxUnits: number
  private readonly searchCap: number
  private readonly assignmentCap: number | undefined
  private readonly assignmentShare: number
  private readonly commitCap: number
  private readonly capacity: number
  private readonly maxOrders: number
  constructor(port: WorkerPort, options: WorkerOptions = {}) {
    this.port = port
    this.maxUnits = options.maxUnits ?? 1000; this.searchCap = options.searchCap ?? 4096
    this.assignmentCap = options.assignmentCap; this.assignmentShare = options.assignmentShare ?? 8; this.commitCap = options.commitCap ?? 16
    this.capacity = options.inventoryCapacity ?? 512; this.maxOrders = options.maxOrders ?? 128
    for (const [name, n] of Object.entries({ maxUnits: this.maxUnits, searchCap: this.searchCap, assignmentCap: this.assignmentCap ?? 16, assignmentShare: this.assignmentShare, commitCap: this.commitCap, capacity: this.capacity, maxOrders: this.maxOrders, maxSearchNodes: options.maxSearchNodes ?? 16384 })) {
      if (!integer(n, 1, 1 << 20)) throw new RangeError(`workers ${name} must be a positive integer <= 1048576`)
    }
    this.nav = new NavigationSystem({ ...port, safe: (x, y, z) => port.safe(x, y, z) && !this.reservedPose(x, y, z) }, options.maxSearchNodes ?? 16384)
    const R = port.registry
    this.dig = new Uint16Array(R.count); this.build = new Uint16Array(R.count); this.drops = new Uint16Array(R.count); this.tools = new Array(R.count)
    for (const [name, m] of Object.entries(options.materials ?? {})) {
      const id = R.id(name)
      if (!R.solid[id] || R.liquid[id]) throw new Error(`work material ${name} must be solid`)
      for (const [field, value] of Object.entries({ digTicks: m.digTicks, buildTicks: m.buildTicks })) if (value !== undefined && !integer(value, 1, 65535)) throw new RangeError(`${name}.${field} must be in 1..65535`)
      if (m.tool !== undefined && (typeof m.tool !== 'string' || !m.tool.length)) throw new Error('tool must be a nonempty string')
      this.dig[id] = m.digTicks ?? 0; this.build[id] = m.buildTicks ?? 0; this.drops[id] = m.drop === undefined ? id : R.id(m.drop); this.tools[id] = m.tool
    }
  }
  get busy(): boolean { return this.nav.pending > 0 || [...this.units.values()].some(u => u.state === 'walking' || u.state === 'working' || u.state === 'falling' || u.state === 'planning') || this.orders.some(o => !o.cancelled && o.cursor < o.total) }
  afterWrite(x: number, y: number, z: number, old: number, value: number): void {
    const R = this.port.registry, a = voxelId(old), b = voxelId(value)
    // Liquid flow is dynamic state, retried while dynamicBusy(); only geometry and solid material swaps wake failures.
    if (R.solid[a] !== R.solid[b] || R.structural[a] !== R.structural[b] || R.falls[a] !== R.falls[b]) { this.nav.invalidate(x, y, z); this.worldRevision++; this.revision++ }
    else if (a !== b && !R.liquid[a] && !R.liquid[b]) this.revision++
  }
  invalidateAll(): void { this.nav.reset(); this.revision++; this.worldRevision++; this.policy++ }
  geometryChanged(old: Uint16Array, value: Uint16Array): boolean {
    const R = this.port.registry
    for (let i = 0; i < old.length; i++) {
      const a = voxelId(old[i]!), b = voxelId(value[i]!)
      if (R.solid[a] !== R.solid[b] || R.structural[a] !== R.structural[b] || R.falls[a] !== R.falls[b]) return true
    }
    return false
  }
  replaceChunk(ci: number, geometry: boolean): void {
    this.worldRevision++
    this.revision++; this.policy++
    if (!geometry) return
    const [x, y, z] = this.port.layout.chunkCoords(ci)
    this.nav.invalidateBox(x * 32, y * 32, z * 32, x * 32 + 31, y * 32 + 31, z * 32 + 31)
  }
  overlaps(x: number, y: number, z: number): boolean { return this.occupied.has(this.port.layout.voxelIndex(x, y, z)) }
  overlapsRegion(min: Vec3, max: Vec3): boolean {
    for (const p of this.occupied.keys()) { const c = this.port.layout.voxelCoords(p); if (c.every((v, i) => v >= min[i]! && v <= max[i]!)) return true }
    return false
  }
  columnOverlaps(cx: number, cz: number, data: Uint16Array): boolean {
    const L = this.port.layout
    for (const p of this.occupiedColumns.get(cx + cz * L.cx) ?? []) {
      const [x, y, z] = L.voxelCoords(p), local = (y >> 5) * 32768 + (x & 31) + ((z & 31) << 5) + ((y & 31) << 10)
      if (this.port.registry.solid[voxelId(data[local]!)]) return true
    }
    return false
  }
  private column(p: number): number { const [x, , z] = this.port.layout.voxelCoords(p); return (x >> 5) + (z >> 5) * this.port.layout.cx }
  private release(u: Unit): void {
    for (const p of u.cells) if (this.occupied.get(p) === u.id) {
      this.occupied.delete(p); const col = this.column(p), set = this.occupiedColumns.get(col); set?.delete(p); if (!set?.size) this.occupiedColumns.delete(col)
    }
    u.cells = []
  }
  private pose(u: Unit): Vec3 { return [u.x >> 8, u.y >> 8, u.z >> 8] }
  private position(u: Unit): number { return this.port.layout.voxelIndex(...this.pose(u)) }
  private body(x: number, y: number, z: number): number[] {
    const L = this.port.layout, cells: number[] = []
    for (let yy = y >> 8; yy <= (y + 511) >> 8; yy++) for (let zz = (z - 96) >> 8; zz <= (z + 95) >> 8; zz++) for (let xx = (x - 96) >> 8; xx <= (x + 95) >> 8; xx++) {
      if (!L.inBounds(xx, yy, zz)) return [-1]
      cells.push(L.voxelIndex(xx, yy, zz))
    }
    return cells
  }
  private reserve(u: Unit, cells: number[]): boolean {
    if (cells.some(p => p < 0 || this.occupied.has(p) && this.occupied.get(p) !== u.id)) return false
    this.release(u)
    for (const p of cells) { this.occupied.set(p, u.id); const col = this.column(p); let set = this.occupiedColumns.get(col); if (!set) { set = new Set(); this.occupiedColumns.set(col, set) }; set.add(p) }
    u.cells = cells; return true
  }
  private volumeFree(cells: number[]): boolean { return cells.every(p => p >= 0 && !this.port.registry.solid[voxelId(this.port.get(...this.port.layout.voxelCoords(p)))] && !this.port.hazard(...this.port.layout.voxelCoords(p))) }
  private hasSupport(u: Pick<Unit, 'x' | 'y' | 'z'>): boolean {
    if (u.y === 0) return true
    if (u.y & 255) return false
    for (let z = (u.z - 96) >> 8; z <= (u.z + 95) >> 8; z++) for (let x = (u.x - 96) >> 8; x <= (u.x + 95) >> 8; x++) if (this.port.registry.solid[voxelId(this.port.get(x, (u.y >> 8) - 1, z))]) return true
    return false
  }
  private ringOf(o: Order, x: number, z: number): number { return Math.min(x - o.min[0], o.max[0] - x, z - o.min[2], o.max[2] - z) }
  /**
   * Whether build order o forbids a body cell: any cell of its box except the scaffold, i.e. unbuilt cells of the current
   * layer outside the ring being placed. A head may rise into the layers above the current one.
   */
  private reservedBy(o: Order, x: number, y: number, z: number, head: boolean): boolean {
    if (x < o.min[0] || x > o.max[0] || y < o.min[1] || y > o.max[1] || z < o.min[2] || z > o.max[2]) return false
    if (o.stalled) return true
    const layer = y - o.min[1]
    if (layer > o.floor) return !head
    return !(layer === o.floor && this.ringOf(o, x, z) < o.ring)
  }
  private reservedPose(x: number, y: number, z: number, except?: readonly Order[]): boolean {
    const a = this.reservedMin, b = this.reservedMax
    if (x < a[0] || x > b[0] || y + 1 < a[1] || y > b[1] || z < a[2] || z > b[2]) return false
    for (const o of this.reservations) if (!except?.includes(o) && (this.reservedBy(o, x, y, z, false) || this.reservedBy(o, x, y + 1, z, true))) return true
    return false
  }
  private inBuildBox(pos: Vec3): boolean { return this.reservations.some(o => pos.every((v, i) => v >= o.min[i]! && v <= o.max[i]!)) }
  /** Any change to a designation's reserved cells: cancel searches and drop routes that relied on the old policy near it. */
  private buildReservationsChanged(o?: Order): void {
    this.reservations = this.orders.filter(o => o.kind === 'build' && !o.cancelled && o.done < o.total)
    this.reservedMin = [Infinity, Infinity, Infinity]; this.reservedMax = [-Infinity, -Infinity, -Infinity]
    for (const r of this.reservations) for (let i = 0; i < 3; i++) { this.reservedMin[i] = Math.min(this.reservedMin[i]!, r.min[i]!); this.reservedMax[i] = Math.max(this.reservedMax[i]!, r.max[i]!) }
    this.worldRevision++; this.revision++; this.policy++
    if (!o) return
    const min: Vec3 = [o.min[0], o.min[1] - 1, o.min[2]], max = o.max
    this.nav.invalidatePolicy(min, max)
    const near = (p: number) => { const c = this.port.layout.voxelCoords(p); return c.every((v, i) => v >= min[i]! && v <= max[i]!) }
    const crosses = (u: Unit, path: readonly number[], from: number) => { for (let i = from; i < path.length; i++) if (near(path[i]!) && !this.poseOk(u, this.port.layout.voxelCoords(path[i]!))) return true; return false }
    // Results that already left the navigation queue, adopted paths and walking alternatives were planned under the old policy.
    for (const u of this.units.values()) {
      if (u.search?.status === 'found' && crosses(u, u.search.path, 0)) u.search.cancel()
      if (crosses(u, u.path, u.cursor)) { u.path = []; u.cursor = 0 }
      if (crosses(u, u.alternative, 0)) { u.alternative = []; u.alternativeCost = 0 }
    }
  }
  private buildCellDone(o: Order, pos: Vec3): void {
    if (!o.ringPending || o.id < 0) return
    o.ringPending[(pos[1] - o.min[1]) * o.rings + this.ringOf(o, pos[0], pos[2])]!--
    o.progress = this.time
    const layers = o.ringPending.length / o.rings, before = o.floor * o.rings + o.ring
    while (o.floor < layers && !o.ringPending[o.floor * o.rings + o.ring]) { if (o.ring > 0) o.ring--; else { o.floor++; o.ring = o.rings - 1; o.stalled = false } }
    if (o.floor * o.rings + o.ring !== before && !o.cancelled && o.done < o.total) this.buildReservationsChanged(o)
  }
  /** Only the current layer's current ring is workable, unless the layer stalled and fell back to plain bottom-up order. */
  private workable(t: Task): boolean {
    const o = t.order
    return !o.ringPending || o.stalled || t.pos[1] - o.min[1] === o.floor && this.ringOf(o, t.pos[0], t.pos[2]) === o.ring
  }
  private safePose(pos: Vec3): boolean { return this.nav.stand(...pos) && this.nav.allowed(this.port.layout.voxelIndex(...pos)) }
  /** Safety that lets a unit cross the designations it started inside, and only those, on its way out. */
  private exitAllowed(p: number, escape: readonly Order[]): boolean { const c = this.port.layout.voxelCoords(p); return this.port.safe(...c) && !this.port.hazard(...c) && !this.reservedPose(...c, escape) }
  private poseOk(u: Unit, pos: Vec3): boolean { return u.escape.length ? this.nav.stand(...pos) && this.exitAllowed(this.port.layout.voxelIndex(...pos), u.escape) : this.safePose(pos) }
  private request(u: Unit, goals: readonly number[], blocked?: ReadonlySet<number>, accept?: (p: number) => boolean): PathSearch {
    const [x, y, z] = this.pose(u), escape = this.reservations.filter(o => this.reservedBy(o, x, y, z, false) || this.reservedBy(o, x, y + 1, z, true))
    u.escape = escape
    return this.nav.request(this.position(u), goals, blocked, { ...(escape.length && { allowed: (p: number) => this.exitAllowed(p, escape) }), ...(accept && { accept }) })
  }
  private stockCount(u: Unit): number { let n = 0; for (const q of u.stock.values()) n += q; return n }
  private ids(cmd: { ids?: unknown }, required = true): Unit[] {
    if (!required && cmd.ids === undefined) return []
    if (!Array.isArray(cmd.ids) || !cmd.ids.length || cmd.ids.length > this.maxUnits || new Set(cmd.ids).size !== cmd.ids.length) throw new Error('ids must be a nonempty list of distinct unit ids')
    return cmd.ids.map(id => { if (!integer(id, 1) || !this.units.has(id)) throw new Error(`unknown unit ${String(id)}`); return this.units.get(id)! })
  }
  private checkPos(p: unknown): asserts p is Vec3 { if (!Array.isArray(p) || p.length !== 3 || !this.port.layout.inBounds(p[0], p[1], p[2])) throw new Error('position must be an in-bounds integer [x,y,z]') }
  private clearOrder(u: Unit): void {
    // Flat shortcuts may span many nodes; cancellation must stop at the current supported pose.
    if (u.motion?.flat) { u.motion = null; this.reserve(u, this.body(u.x, u.y, u.z)) }
    this.resetRoute(u); u.goal = null; u.stale = 0
    if (u.task) { if (u.task.order.id < 0) this.targets.delete(u.task.p); u.task.claim = 0; u.task = null }
    u.reason = undefined; u.wait = 0
    if (!u.motion && u.state !== 'incapacitated' && u.state !== 'falling') u.state = 'idle'
    this.dirty.add(u.id)
  }
  command(command: Command): void {
    const c = command as WorkerCommand
    if (c.type === 'unitSpawn') {
      this.checkPos(c.pos)
      if (this.units.size >= this.maxUnits) throw new Error('unit limit reached')
      if (!this.safePose(c.pos)) throw new Error('spawn needs clear body, safe water and support')
      if (c.tools !== undefined && (!Array.isArray(c.tools) || c.tools.length > 16 || c.tools.some(t => typeof t !== 'string' || !t.length || t.length > 64))) throw new Error('invalid tools')
      const stock = new Map<number, number>()
      if (c.stock !== undefined) {
        if (!Array.isArray(c.stock) || c.stock.length > 64) throw new Error('invalid stock')
        for (const item of c.stock) {
          if (!item || !integer(item.block, 1, this.port.registry.count - 1) || !integer(item.count, 0, this.capacity)) throw new Error('invalid stock item')
          stock.set(item.block, (stock.get(item.block) ?? 0) + item.count)
        }
      }
      const u: Unit = { id: this.nextUnit, x: c.pos[0] * 256 + 128, y: c.pos[1] * 256, z: c.pos[2] * 256 + 128, facing: 0, state: 'idle', tools: new Set(c.tools), stock,
        goal: null, search: null, path: [], cursor: 0, task: null, progress: 0, duration: 0, cells: [], motion: null, vy: 0, wait: 0, retry: 0, revision: -1,
        allowDig: false, buildBlock: 0, engineering: null, searchLimited: false, actions: [], actionCursor: 0, alternative: [], alternativeCost: 0, workPoses: [], validatedWorld: -1, validatedPose: [0, 0, 0], available: true, escape: [], exposed: 0, unsafeHere: false, stale: 0, progressAt: this.time, route: null, segment: null }
      if (this.stockCount(u) > this.capacity) throw new Error('inventory capacity exceeded')
      if (!this.reserve(u, this.body(u.x, u.y, u.z))) throw new Error('spawn overlaps a unit')
      this.nextUnit++; this.units.set(u.id, u); this.revision++; this.dirty.add(u.id); this.port.emit('unitSpawned', { id: u.id }); return
    }
    if (c.type === 'workCancel') {
      if (!integer(c.order, 1)) throw new Error('invalid order id')
      const o = this.orders.find(o => o.id === c.order); if (!o) throw new Error('unknown order')
      this.cancelOrder(o); return
    }
    if (c.type === 'workDig' || c.type === 'workBuild') {
      this.checkPos(c.min); this.checkPos(c.max)
      let total = 1
      for (let a = 0; a < 3; a++) { if (c.max[a]! < c.min[a]!) throw new Error('min must be <= max'); total *= c.max[a]! - c.min[a]! + 1 }
      if (total > MAX_AREA) throw new Error('designation too large')
      const ids = this.ids(c, false)
      if (ids.length && ids.every(u => u.state === 'incapacitated')) throw new Error('no listed unit can work')
      if (c.priority !== undefined && !integer(c.priority, 0, 255)) throw new Error('invalid priority')
      const voxel = c.type === 'workBuild' ? c.voxel : 0
      if (c.type === 'workBuild' && (!integer(voxel, 1, 65535) || !this.build[voxelId(voxel)])) throw new Error('material is not buildable')
      this.orders = this.orders.filter(o => !o.cancelled && o.done < o.total)
      if (this.orders.length >= this.maxOrders) throw new Error('order limit reached')
      const sx = c.max[0] - c.min[0] + 1, sz = c.max[2] - c.min[2] + 1, rings = Math.floor((Math.min(sx, sz) - 1) / 2) + 1
      let ringPending: Int32Array | null = null
      if (c.type === 'workBuild') {
        ringPending = new Int32Array((c.max[1] - c.min[1] + 1) * rings)
        for (let i = 0; i < ringPending.length; i++) { const r = i % rings; ringPending[i] = inner(sx, sz, r) - inner(sx, sz, r + 1) }
      }
      const o: Order = { id: this.nextOrder++, kind: c.type === 'workDig' ? 'dig' : 'build', min: [...c.min] as Vec3, max: [...c.max] as Vec3, voxel, total, done: 0, pending: total, cancelled: false, cursor: 0, ids: c.ids === undefined ? null : new Set(ids.map(u => u.id)), priority: c.priority ?? 128, parked: [], parkedRevision: -1,
        ringPending, rings, floor: 0, ring: rings - 1, progress: this.time, stalled: false, idleSince: this.time, noCrewSince: -1 }
      for (const u of c.ids === undefined ? this.units.values() : ids) { u.available = true; this.dirty.add(u.id) }
      this.revision++; this.orders.push(o); if (o.kind === 'build') this.buildReservationsChanged(o); this.port.emit('workOrdered', { id: o.id }); return
    }
    const units = this.ids(c)
    if (c.type === 'unitCollect') {
      for (const u of units) {
        const [x, y, z] = this.pose(u)
        let free = this.capacity - this.stockCount(u)
        for (const [dx, dz] of [[0, 0], ...DIRS]) for (let dy = -1; dy <= 1 && free > 0; dy++) {
          const pos: Vec3 = [x + dx!, y + dy, z + dz!]
          if (!this.port.layout.inBounds(...pos) || this.port.registry.solid[voxelId(this.port.get(...pos))]) continue
          const p = this.port.layout.voxelIndex(...pos), pile = this.loose.get(p)
          if (!pile) continue
          for (const [block, count] of pile) {
            const n = Math.min(count, free); if (!n) break
            free -= n; u.stock.set(block, (u.stock.get(block) ?? 0) + n)
            if (count === n) pile.delete(block); else pile.set(block, count - n)
            this.dirtyDrops.set(`${p}:${block}`, { pos, block, count: count - n })
          }
          if (!pile.size) this.loose.delete(p)
        }
        this.dirty.add(u.id)
      }
      this.revision++; return
    }
    if (c.type === 'unitStock') {
      if (!integer(c.block, 1, this.port.registry.count - 1) || !integer(c.count, 0, this.capacity)) throw new Error('invalid stock')
      for (const u of units) if (this.stockCount(u) + c.count > this.capacity) throw new Error('inventory capacity exceeded')
      for (const u of units) { u.stock.set(c.block, (u.stock.get(c.block) ?? 0) + c.count); this.dirty.add(u.id) }
      this.revision++; return
    }
    if (c.type === 'unitMove') {
      if (c.allowDig !== undefined && typeof c.allowDig !== 'boolean') throw new Error('allowDig must be boolean')
      if (c.buildBlock !== undefined && (!integer(c.buildBlock, 1, this.port.registry.count - 1) || !this.build[c.buildBlock])) throw new Error('invalid route build material')
      this.checkPos(c.pos)
      if (!this.nav.stand(...c.pos)) throw new Error('move destination needs body clearance and support')
      const destinations: number[] = [], chosen = new Set<number>()
      const selectedIds = new Set(units.map(u => u.id)), spacing = units.length > 1 ? 2 : 1
      const taken = new Set<number>()
      for (const u of this.units.values()) if (!selectedIds.has(u.id) && u.goal !== null) taken.add(u.goal)
      // Deterministic square spiral formation; each unit gets its own supported destination.
      formation: for (let radius = 0; radius <= 32 && destinations.length < units.length; radius++) for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue
        const pos: Vec3 = [c.pos[0] + dx * spacing, c.pos[1], c.pos[2] + dz * spacing]
        if (!this.safePose(pos)) continue
        const p = this.port.layout.voxelIndex(...pos), owner = this.occupied.get(p)
        if (!chosen.has(p) && !taken.has(p) && (owner === undefined || selectedIds.has(owner))) { destinations.push(p); chosen.add(p) }
        if (destinations.length === units.length) break formation
      }
      if (destinations.length < units.length) throw new Error('not enough safe formation destinations')
      units.forEach((u, i) => { this.clearOrder(u); if (u.state !== 'incapacitated') { u.available = true; u.goal = destinations[i]!; u.allowDig = c.allowDig === true; u.buildBlock = c.buildBlock ?? 0; u.state = u.motion ? 'walking' : 'planning'; u.retry = 0; u.revision = -1 } })
      // Units that would each plan a long route share one reverse field from all their destinations.
      const members = units.filter(u => u.state !== 'incapacitated' && !u.motion && !u.allowDig && !u.buildBlock && !this.escaping(u) && this.estimate(u, [u.goal!]) > HIER_MIN)
      if (members.length > 1) {
        const field = this.nav.group(members.map(u => u.goal!), members.map(u => this.position(u)))
        for (const u of members) { u.route = this.newRoute(field, [u.goal!]); u.escape = [] }
      }
    } else if (c.type === 'unitCancel') for (const u of units) { this.clearOrder(u); u.available = false }
    else if (c.type === 'unitDespawn') { for (const u of units) { this.clearOrder(u); this.release(u); this.units.delete(u.id); this.dirty.delete(u.id); for (const t of this.tasks) t.failures.delete(u.id); for (const h of this.parkedFailures.values()) h.failures.delete(u.id) }; this.cancelOrphanOrders() }
    this.revision++
  }
  private cancelOrder(o: Order): void {
    const reserved = o.kind === 'build' && !o.cancelled && o.done < o.total
    o.cancelled = true; o.parked = []
    for (const u of this.units.values()) if (u.task?.order === o) this.clearOrder(u)
    for (const t of this.tasks.filter(t => t.order === o)) this.removeTask(t, false)
    if (reserved) this.buildReservationsChanged(o)
  }
  /** An order restricted to units that are gone or incapacitated can never progress and would hold frontier slots forever. */
  private cancelOrphanOrders(): void {
    for (const o of this.orders) if (o.ids && !o.cancelled && o.done < o.total && ![...o.ids].some(id => { const u = this.units.get(id); return u !== undefined && u.state !== 'incapacitated' })) this.cancelOrder(o)
  }
  private removeTask(t: Task, done: boolean): void {
    this.tasks = this.tasks.filter(q => q !== t); this.unindex(t); this.targets.delete(t.p)
    if (done) {
      t.order.done++; t.order.pending--; t.order.reason = undefined; t.order.idleSince = this.time
      if (t.order.kind === 'build') this.buildCellDone(t.order, t.pos)
      if (t.order.kind === 'build' && t.order.id > 0 && !t.order.cancelled && t.order.done === t.order.total) this.buildReservationsChanged(t.order)
      if (t.order.done === t.order.total && t.order.id > 0) this.port.emit('workCompleted', { id: t.order.id })
    }
  }
  private satisfied(t: Task): boolean { const v = this.port.get(...t.pos); return t.order.kind === 'dig' ? !this.port.registry.solid[voxelId(v)] : v === t.order.voxel }
  private canWork(pos: Vec3, t: Task): boolean {
    if (!this.safePose(pos)) return false
    const [x, y, z] = pos, [tx, ty, tz] = t.pos
    if (Math.abs(x - tx) + Math.abs(z - tz) > 1 || ty < y - 1 || ty > y + 1 || x === tx && z === tz) return false
    const origin: Vec3 = [x + .5, y + 1, z + .5], target: Vec3 = [tx + .5, ty + .5, tz + .5]
    const dir: Vec3 = [target[0] - origin[0], target[1] - origin[1], target[2] - origin[2]], distance = Math.sqrt(dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2])
    const hit = raycast(this.port.get, v => this.port.registry.solid[voxelId(v)] === 1, this.port.layout.size, origin, dir, distance)
    return !hit || this.port.layout.voxelIndex(...hit.pos) === t.p
  }
  private workGoals(u: Unit, t: Task, ignoreOccupancy = false): number[] {
    const out: number[] = [], [x, y, z] = t.pos
    for (const [dx, dz] of DIRS) for (let yy = y - 1; yy <= y + 1; yy++) {
      const pos: Vec3 = [x + dx, yy, z + dz]
      if (!this.canWork(pos, t)) continue
      const p = this.port.layout.voxelIndex(...pos)
      if (ignoreOccupancy || (!this.occupied.has(p) || this.occupied.get(p) === u.id) && (!this.workPositions.has(p) || this.workPositions.get(p) === u.id) && !this.poseHeld(p, u)) out.push(p)
    }
    return out
  }
  /** Hook for the reservation table: whether another unit holds pose p (untimed hold). No table yet, so never. */
  private poseHeld(_p: number, _u: Unit): boolean { return false }
  /** Nav tiles whose edges decide whether the task's work poses are reachable from nearby. */
  private tilesAround(pos: Vec3): Map<number, number> {
    const [sx, sy, sz] = this.port.layout.size, tiles = new Map<number, number>()
    for (let y = Math.max(0, pos[1] - 3) >> 4; y <= Math.min(sy - 1, pos[1] + 3) >> 4; y++) for (let z = Math.max(0, pos[2] - 2) >> 4; z <= Math.min(sz - 1, pos[2] + 2) >> 4; z++) for (let x = Math.max(0, pos[0] - 2) >> 4; x <= Math.min(sx - 1, pos[0] + 2) >> 4; x++) {
      const ti = this.nav.tileOf(x << 4, y << 4, z << 4); tiles.set(ti, this.nav.revisions[ti]!)
    }
    return tiles
  }
  private taskFailure(t: Task, u: Unit, reason: WorkBlockReason, tiles?: ReadonlyMap<number, number>): void {
    const retry = this.time + (reason === 'traffic' ? 20 : 40)
    if (reason === 'missing-material' || reason === 'missing-tool') {
      t.failures.delete(u.id)
      // A worker that cannot do the task at all must not hide why a capable one is stuck.
      if (t.failures.size) return
    } else {
      // Bounded per task: an evicted worker merely retries, and assignment attempts are capped per tick.
      t.failures.delete(u.id)
      if (t.failures.size >= MAX_FAILURES) t.failures.delete(t.failures.keys().next().value!)
      t.failures.set(u.id, { origin: this.position(u), policy: this.policy, nav: this.nav.revision, tiles: tiles ?? this.tilesAround(t.pos), retry, reason })
    }
    t.reason = reason; t.order.reason = reason
  }
  private canRetry(t: Task, u: Unit): boolean {
    const f = t.failures.get(u.id)
    if (!f || f.origin !== this.position(u) || f.policy !== this.policy) return true
    if (f.retry <= this.time && (f.reason === 'traffic' || this.dynamicWasBusy)) return true
    // Unrelated edits elsewhere leave the failure standing; any change to a tile the failed plan read reopens it.
    if (f.nav !== this.nav.revision) { for (const [ti, rev] of f.tiles) if (this.nav.revisions[ti] !== rev) return true; f.nav = this.nav.revision }
    return false
  }
  /** Drops every route artifact: search, path, engineering plan, walking alternative and work-pose claims. */
  private resetRoute(u: Unit): void {
    this.releaseWorkPoses(u); this.dropRoute(u)
    u.engineering?.cancel(); u.engineering = null; u.searchLimited = false; u.actions = []; u.actionCursor = 0; u.alternative = []; u.alternativeCost = 0
    u.search?.cancel(); u.search = null; u.path = []; u.cursor = 0; u.progress = 0; u.escape = []
  }
  private block(u: Unit, reason: WorkBlockReason, tiles?: ReadonlyMap<number, number>): void {
    this.resetRoute(u); u.stale = 0
    u.reason = reason; u.retry = this.time + (reason === 'traffic' ? 20 : 40); u.revision = this.revision
    if (u.task) { if (u.task.order.id < 0) this.targets.delete(u.task.p); this.taskFailure(u.task, u, reason, tiles); u.task.claim = 0; u.task = null }
    // Only a move order waits in 'blocked'; a unit without one stays assignable.
    u.state = u.goal === null ? 'idle' : 'blocked'
    this.dirty.add(u.id)
  }
  private finish(u: Unit): void {
    this.releaseWorkPoses(u)
    const t = u.task!
    this.removeTask(t, true); u.task = null; u.progress = 0; u.duration = 0; u.state = u.goal === null ? 'idle' : 'planning'; u.reason = undefined; this.dirty.add(u.id)
  }
  beforePhysics(): void {
    this.mutations = 0
    for (const u of this.units.values()) {
      const t = u.task
      if (!t || u.state !== 'working' || u.progress < u.duration || this.mutations >= this.commitCap) continue
      if (this.satisfied(t)) { this.finish(u); continue }
      if (!this.canWork(this.pose(u), t)) { this.block(u, 'unsafe'); continue }
      const v = this.port.get(...t.pos), id = voxelId(v), build = t.order.kind === 'build', material = voxelId(t.order.voxel)
      if (v !== t.expected) { t.expected = v; this.block(u, 'target-changed'); t.failures.delete(u.id); u.revision = -1; continue }
      if (build && this.port.registry.solid[id]) { this.block(u, 'target-changed'); continue }
      if (build && this.overlaps(...t.pos)) { this.block(u, 'traffic'); continue }
      if (build && !(u.stock.get(material) ?? 0)) { this.block(u, 'missing-material'); continue }
      if (!build && (!this.dig[id] || this.tools[id] && !u.tools.has(this.tools[id]!))) { this.block(u, 'missing-tool'); continue }
      if (build && !this.attached(t.pos)) { this.block(u, 'no-access'); continue }
      const drop = this.drops[id]!
      const ok = this.port.edit(t.pos, v, build ? t.order.voxel : 0, () => {
        if (build) u.stock.set(material, u.stock.get(material)! - 1)
        else if (drop) {
          if (this.stockCount(u) < this.capacity) u.stock.set(drop, (u.stock.get(drop) ?? 0) + 1)
          else { let pile = this.loose.get(t.p); if (!pile) { pile = new Map(); this.loose.set(t.p, pile) }; const count = (pile.get(drop) ?? 0) + 1; pile.set(drop, count); this.dirtyDrops.set(`${t.p}:${drop}`, { pos: t.pos, block: drop, count }); this.port.emit('workDrop', { pos: t.pos, block: drop, count: 1 }) }
        }
        this.barriers.push({ unit: u.id, pos: t.pos }); this.finish(u); this.mutations++
      })
      if (!ok) this.block(u, 'unsafe')
    }
  }
  private attached(pos: Vec3): boolean {
    const [x, y, z] = pos
    if (y === 0) return true
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const id = voxelId(this.port.get(x + dx!, y + dy!, z + dz!))
      if (this.port.registry.solid[id] && !this.port.registry.falls[id]) return true
    }
    return false
  }
  /** Dig exposes the top layer first; build rests each layer on the one below and places it from the innermost ring out. */
  private cell(o: Order, i: number): Vec3 {
    const sx = o.max[0] - o.min[0] + 1, sz = o.max[2] - o.min[2] + 1, layer = Math.floor(i / (sx * sz))
    if (o.kind === 'dig') return [o.min[0] + i % sx, o.max[1] - layer, o.min[2] + Math.floor(i / sx) % sz]
    const k = i % (sx * sz)
    let r = 0
    while (inner(sx, sz, r + 1) > k) r++
    // Walk ring r's rectangle: top row, right column, bottom row back, left column up.
    const j = k - inner(sx, sz, r + 1), x0 = o.min[0] + r, x1 = o.max[0] - r, z0 = o.min[2] + r, z1 = o.max[2] - r, w = x1 - x0 + 1, d = z1 - z0 + 1, y = o.min[1] + layer
    if (w === 1) return [x0, y, z0 + j]
    if (d === 1) return [x0 + j, y, z0]
    if (j < w) return [x0 + j, y, z0]
    if (j < w + d - 1) return [x1, y, z0 + j - w + 1]
    if (j < 2 * w + d - 2) return [x1 - (j - w - d + 2), y, z1]
    return [x0, y, z1 - (j - 2 * w - d + 3)]
  }
  /** Frontier tasks per order, all of them or only the live ones (not blocked); blocked tasks never count against a share. */
  private held(live: boolean): Map<Order, number> { const held = new Map<Order, number>(); for (const t of this.tasks) if (!live || t.reason === undefined) held.set(t.order, (held.get(t.order) ?? 0) + 1); return held }
  /** Blocked, beyond its order's share, or its order without crew for a while; never a task added this tick. */
  private parkable(t: Task, live: ReadonlyMap<Order, number>): boolean {
    const o = t.order
    return t.added < this.time && (t.reason !== undefined || (live.get(o) ?? 0) > (this.share.get(o.id) ?? Infinity) || o.noCrewSince >= 0 && this.time - o.noCrewSince >= NO_CREW_TICKS)
  }
  /** Moves an unclaimed parkable task back to its order, lowest effective priority first, so the bounded frontier can hold other cells. */
  private park(live = this.held(true)): boolean {
    const k = parkChoice(this.tasks.map(t => ({ i: t.i, priority: this.effective(t.order), added: t.added, claimed: t.claim !== 0, parkable: this.parkable(t, live) })))
    if (k < 0) return false
    const t = this.tasks[k]!
    this.tasks.splice(k, 1); this.unindex(t); this.targets.delete(t.p); t.order.parked.push(t.i)
    if (t.reason === undefined) live.set(t.order, live.get(t.order)! - 1)
    // A task parked only to make room has no history worth keeping.
    this.parkedFailures.delete(t.p)
    if (t.reason === undefined && !t.failures.size) return true
    if (this.parkedFailures.size >= MAX_PARKED_FAILURES) this.parkedFailures.delete(this.parkedFailures.keys().next().value!)
    this.parkedFailures.set(t.p, { reason: t.reason, failures: t.failures })
    return true
  }
  private effective(o: Order): number { return effectivePriority(o.priority, o.idleSince, this.time) }
  private hasWorker(o: Order): boolean {
    return !o.ids || [...o.ids].some(id => { const u = this.units.get(id); return u !== undefined && u.available && u.state !== 'incapacitated' })
  }
  /** Cells the order could still add to the frontier: fresh ones up to the build ring gate, and parked ones. */
  private exposable(o: Order): number {
    let end = o.total
    if (o.ringPending && !o.stalled) { const sx = o.max[0] - o.min[0] + 1, sz = o.max[2] - o.min[2] + 1; end = Math.min(o.total, o.floor * sx * sz + inner(sx, sz, o.ring)) }
    return Math.max(0, end - o.cursor) + o.parked.length
  }
  private expand(): void {
    let cap = 256, parks = MAX_PARKS
    const active = this.orders.filter(o => !o.cancelled && o.done < o.total).sort((a, b) => this.effective(b) - this.effective(a) || a.id - b.id)
    const held = this.held(false), live = this.held(true)
    for (const o of active) o.noCrewSince = this.hasWorker(o) ? -1 : o.noCrewSince < 0 ? this.time : o.noCrewSince
    this.share = shares(active.map(o => ({ id: o.id, weight: this.effective(o), open: (held.get(o) ?? 0) + this.exposable(o) })), MAX_TASKS)
    for (const o of active) while (cap > 0 && (live.get(o) ?? 0) < this.share.get(o.id)! && (o.cursor < o.total || o.parked.length)) {
      const fresh = o.cursor < o.total
      // A build only exposes cells it may work on now, so later rings never crowd the current one out of the frontier.
      if (fresh && o.ringPending && !o.stalled) { const next = this.cell(o, o.cursor); if (next[1] - o.min[1] > o.floor || next[1] - o.min[1] === o.floor && this.ringOf(o, next[0], next[2]) < o.ring) break }
      if (this.tasks.length >= MAX_TASKS) {
        // Parked cells come back through a full frontier only after something that could unblock them changed.
        if (!fresh && o.parkedRevision === this.revision || parks <= 0 || !this.park(live)) break
        parks--
      }
      if (!fresh) o.parkedRevision = this.revision
      const i = fresh ? o.cursor++ : o.parked.shift()!, pos = this.cell(o, i), p = this.port.layout.voxelIndex(...pos)
      cap--
      const t: Task = { order: o, i, pos, p, expected: this.port.get(...pos), claim: 0, added: this.time, failures: new Map() }
      if (this.satisfied(t)) { o.done++; o.pending--; o.idleSince = this.time; if (o.kind === 'build') this.buildCellDone(o, pos); if (o.done === o.total) { if (o.kind === 'build') this.buildReservationsChanged(o); this.port.emit('workCompleted', { id: o.id }) }; continue }
      if (this.targets.has(p)) { if (fresh) o.cursor--; else o.parked.unshift(i); break }
      const history = fresh ? undefined : this.parkedFailures.get(p)
      if (history) { this.parkedFailures.delete(p); t.reason = history.reason; t.failures = history.failures }
      this.targets.add(p); this.tasks.push(t); this.index(t); if (t.reason === undefined) live.set(o, (live.get(o) ?? 0) + 1)
    }
  }
  private taskColumn(t: Task): number { return (t.pos[0] >> 5) + (t.pos[2] >> 5) * this.port.layout.cx }
  private index(t: Task): void { const c = this.taskColumn(t), list = this.taskIndex.get(c); if (list) list.push(t); else this.taskIndex.set(c, [t]) }
  private unindex(t: Task): void {
    const c = this.taskColumn(t), list = this.taskIndex.get(c)
    if (!list) return
    const k = list.indexOf(t)
    if (k >= 0) list.splice(k, 1)
    if (!list.length) this.taskIndex.delete(c)
  }
  /**
   * Tasks unit u may take, from its chunk column and the 8 around it, widened ring by ring until there are 16 or ring 4
   * is reached; past that, every frontier task. Priority stays global: the 16 nearest tasks of orders ranked strictly
   * above the best nearby one join the set.
   */
  private candidates(u: Unit): Task[] {
    const L = this.port.layout, cx = u.x >> 13, cz = u.z >> 13, out: Task[] = [], eligible = (t: Task) => this.eligible(t, u)
    for (let r = 0; r <= 4; r++) {
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r || cx + dx < 0 || cz + dz < 0 || cx + dx >= L.cx || cz + dz >= L.cz) continue
        for (const t of this.taskIndex.get(cx + dx + (cz + dz) * L.cx) ?? []) if (eligible(t)) out.push(t)
      }
      if (r >= 1 && out.length >= 16) {
        let best = -Infinity
        for (const t of out) best = Math.max(best, this.effective(t.order))
        const above = this.tasks.filter(t => this.effective(t.order) > best && eligible(t))
        if (!above.length) return out
        const far = (t: Task) => Math.abs(t.pos[0] - (u.x >> 8)) + Math.abs(t.pos[1] - (u.y >> 8)) + Math.abs(t.pos[2] - (u.z >> 8))
        return [...out, ...above.sort((a, b) => far(a) - far(b) || a.p - b.p).slice(0, 16)]
      }
    }
    return this.tasks.filter(eligible)
  }
  private eligible(t: Task, u: Unit): boolean { return !t.claim && (!t.order.ids || t.order.ids.has(u.id)) && this.workable(t) && this.canRetry(t, u) }
  private assign(): void {
    const units = [...this.units.values()]
    const assignable = (u: Unit) => u.available && u.goal === null && !u.task && !u.motion && u.state === 'idle'
    let idle = 0
    if (this.assignmentCap === undefined) for (const u of units) if (assignable(u)) idle++
    const perTick = this.assignmentCap ?? Math.max(16, Math.ceil(idle / this.assignmentShare))
    let cap = perTick
    for (let n = 0; n < units.length && cap > 0; n++) {
      const u = units[(this.assignmentCursor + n) % units.length]!
      if (!assignable(u)) continue
      cap--
      const [x, y, z] = this.pose(u)
      const order = (list: Task[]) => list.sort((a, b) => this.effective(b.order) - this.effective(a.order) || (Math.abs(a.pos[0] - x) + Math.abs(a.pos[1] - y) + Math.abs(a.pos[2] - z)) - (Math.abs(b.pos[0] - x) + Math.abs(b.pos[1] - y) + Math.abs(b.pos[2] - z)) || a.order.id - b.order.id || a.p - b.p)
      const near = order(this.candidates(u))
      // Only when every nearby candidate failed without spending the attempts does the unit look at the rest.
      const rest = () => { const seen = new Set(near); return order(this.tasks.filter(t => !seen.has(t) && this.eligible(t, u))) }
      let attempts = 0
      for (const t of chain(near, rest)) {
        if (this.satisfied(t)) { this.removeTask(t, true); continue }
        const id = voxelId(this.port.get(...t.pos)), build = t.order.kind === 'build'
        let reason: WorkBlockReason | undefined
        if (build && !(u.stock.get(voxelId(t.order.voxel)) ?? 0)) reason = 'missing-material'
        else if (!build && (!this.dig[id] || this.tools[id] && !u.tools.has(this.tools[id]!))) reason = 'missing-tool'
        if (reason) { this.taskFailure(t, u, reason); continue }
        if (attempts++ >= 8) break
        if (build && (this.port.registry.solid[id] || !this.attached(t.pos))) reason = 'no-access'
        const goals = reason ? [] : this.workGoals(u, t)
        if (reason || !goals.length) { this.taskFailure(t, u, reason ?? (this.workGoals(u, t, true).length ? 'traffic' : 'no-access')); continue }
        t.claim = u.id; t.expected = this.port.get(...t.pos); t.reason = undefined; u.task = t; u.reason = undefined; u.stale = 0
        // The goals are only the search's targets; the unit claims the one its route ends on when the route is found.
        u.workPoses = goals; u.progressAt = this.time
        this.plan(u, goals); u.state = 'planning'; this.dirty.add(u.id); break
      }
    }
    this.assignmentCursor = units.length ? (this.assignmentCursor + perTick) % units.length : 0
  }
  private releaseWorkPoses(u: Unit): void { for (const p of u.workPoses) if (this.workPositions.get(p) === u.id) this.workPositions.delete(p); u.workPoses = [] }
  private motionPose(to: number, elapsed: number, ticks: number, start: [number, number, number]): [number, number, number] {
    const [tx, ty, tz] = this.port.layout.voxelCoords(to), [sx, sy, sz] = start, y = sy / 256
    if (ty === y) return [sx + Math.trunc((tx * 256 + 128 - sx) * elapsed / ticks), sy, sz + Math.trunc((tz * 256 + 128 - sz) * elapsed / ticks)]
    const q = Math.min(256, Math.floor(elapsed * 256 / ticks))
    const hq = ty > y ? Math.max(0, q * 2 - 256) : ty < y ? Math.min(256, q * 2) : q
    const yq = ty > y ? Math.min(256, q * 2) : ty < y ? Math.max(0, q * 2 - 256) : q
    return [sx + Math.trunc((tx * 256 + 128 - sx) * hq / 256), sy + Math.trunc((ty * 256 - sy) * yq / 256), sz + Math.trunc((tz * 256 + 128 - sz) * hq / 256)]
  }
  /** The unit already stands on its current cells; only cells it moves into must be poses it may occupy. */
  private walkable(u: Unit, cells: number[], y: number): boolean {
    if (!this.volumeFree(cells)) return false
    let here: number[] | undefined
    return cells.every(p => {
      const pos = this.port.layout.voxelCoords(p)
      return pos[1] !== y || this.poseOk(u, pos) || (here ??= this.body(u.x, u.y, u.z)).includes(p)
    })
  }
  private beginPathMotion(u: Unit): boolean {
    // A blocked next step needs traffic arbitration, not repeated long visibility probes.
    if (u.wait) return this.beginMotion(u, u.path[u.cursor]!)
    const L = this.port.layout, y = u.y >> 8
    let end = u.cursor
    while (end < u.path.length && end < u.cursor + WALK_LOOKAHEAD && L.voxelCoords(u.path[end]!)[1] === y) end++
    // Bound both lookahead and probes; never smooth across stairs or engineering edits.
    const stride = Math.max(1, Math.ceil((end - u.cursor) / WALK_PROBES))
    for (let i = end - 1; i > u.cursor; i -= stride) {
      const to = u.path[i]!, [x, , z] = L.voxelCoords(to)
      const cells = walkSweep(L, [u.x, u.y, u.z], [x * 256 + 128, u.y, z * 256 + 128])
      if (cells.some(p => this.occupied.has(p) && this.occupied.get(p) !== u.id) || !this.walkable(u, cells, y)) continue
      return this.beginMotion(u, to, i + 1, cells)
    }
    return this.beginMotion(u, u.path[u.cursor]!)
  }
  private beginMotion(u: Unit, to: number, cursor = u.cursor + 1, visibleCells?: number[]): boolean {
    const from = this.position(u), [x, y, z] = this.port.layout.voxelCoords(from), [tx, ty, tz] = this.port.layout.voxelCoords(to)
    if (!this.poseOk(u, [tx, ty, tz])) { this.block(u, 'unsafe'); return false }
    if (!visibleCells && from !== to && !DIRS.some((_, d) => this.nav.neighbor(from, d) === to)) { this.block(u, 'target-changed'); return false }
    const start: [number, number, number] = [u.x, u.y, u.z]
    const flat = ty * 256 === u.y
    const ticks = flat ? Math.max(1, Math.ceil(ceilSqrt((tx * 256 + 128 - u.x) ** 2 + (tz * 256 + 128 - u.z) ** 2) / WALK_SPEED)) : 4 + (ty > y ? 2 : y - ty)
    let cells: number[], area: Set<number> | null = null
    if (flat) {
      const sweep = visibleCells ?? walkSweep(this.port.layout, start, [tx * 256 + 128, u.y, tz * 256 + 128])
      if (!visibleCells && !this.walkable(u, sweep, y)) { this.block(u, 'unsafe'); return false }
      const valid = new Set(sweep); area = valid
      cells = walkSweep(this.port.layout, start, this.motionPose(to, 1, ticks, start)).filter(p => valid.has(p))
    } else {
      const set = new Set<number>()
      for (let q = 0; q <= ticks * 4; q++) for (const p of this.body(...this.motionPose(to, q / 4, ticks, start))) set.add(p)
      cells = [...set]
    }
    if (!this.volumeFree(cells)) { this.block(u, 'unsafe'); return false }
    if (!this.reserve(u, cells)) {
      u.wait++; u.reason = 'traffic'; this.dirty.add(u.id)
      if (u.wait >= 12) this.yield(u)
      return false
    }
    u.wait = 0; u.reason = undefined; u.motion = { from, to, cursor, start, flat, elapsed: 0, ticks, cells, area }; u.facing = tx !== x ? tx > x ? 1 : 3 : tz > z ? 0 : 2; u.state = 'walking'; this.dirty.add(u.id); return true
  }
  private yield(u: Unit): void {
    const from = this.position(u), intended = u.path[u.cursor], owner = intended === undefined ? undefined : this.occupied.get(intended)
    const other = owner === undefined ? undefined : this.units.get(owner)
    if (owner !== undefined && owner > u.id && other && (other.motion !== null || other.state === 'planning' && other.task !== null) && u.wait < 80) return // an active older id wins for a while; idle bodies still require a detour
    // Engineering actions are tied to the poses of the old plan; a detour replans from scratch.
    u.actions = []; u.actionCursor = 0
    // A settled unit parked on the destination never leaves: take the nearest free pose instead of circling it.
    if (!u.task && u.goal !== null && this.settledOn(u.goal, u.id) && !this.retarget(u)) { this.block(u, 'traffic'); return }
    // A unit on a route detours to the end of its refined path; the route carries on from there.
    const goals = u.route && u.route.last >= 0 ? [u.route.last] : u.task ? this.workGoals(u, u.task) : u.goal !== null ? [u.goal] : []
    if (goals.length && goals.some(p => !this.occupied.has(p) || this.occupied.get(p) === u.id)) {
      // Only bodies near the unit matter for a local detour; distant ones will have moved by the time it gets there.
      const blocked = new Set<number>()
      for (const other of this.units.values()) if (other !== u && Math.abs(other.x - u.x) <= 8 * 256 && Math.abs(other.z - u.z) <= 8 * 256 && Math.abs(other.y - u.y) <= 4 * 256) for (const p of other.cells) blocked.add(p)
      u.search?.cancel(); u.search = this.request(u, goals, blocked); u.path = []; u.cursor = 0; u.wait = 0; u.reason = 'traffic'; u.state = 'planning'; this.dirty.add(u.id); return
    }
    // Sidestep attempts start from wait 0 (no nested yield) but failed ones still count toward the traffic block.
    const wait = u.wait
    for (let d = 0; d < 4; d++) {
      const p = this.nav.neighbor(from, d)
      if (p < 0 || p === intended || this.occupied.has(p) || !this.poseOk(u, this.port.layout.voxelCoords(p))) continue
      u.search?.cancel(); u.search = null; u.path = [from, p]; u.cursor = 1; u.wait = 0; u.retry = this.time + 24
      if (this.beginMotion(u, p)) { u.reason = 'traffic'; this.dirty.add(u.id); return }
      if (u.reason !== 'traffic') return // beginMotion blocked the unit for another reason; it already gave up its task
    }
    u.wait = wait
    if (u.wait >= 80) this.block(u, 'traffic')
  }
  private settledOn(p: number, self: number): boolean {
    const owner = this.occupied.get(p), other = owner === undefined || owner === self ? undefined : this.units.get(owner)
    return !!other && !other.motion && other.goal === null && !other.task && !other.search && !other.route && other.path[other.cursor] === undefined
  }
  private retarget(u: Unit): boolean {
    const [gx, gy, gz] = this.port.layout.voxelCoords(u.goal!), taken = new Set<number>()
    for (const other of this.units.values()) if (other !== u && other.goal !== null) taken.add(other.goal)
    for (let radius = 1; radius <= 4; radius++) for (let dz = -radius; dz <= radius; dz++) for (let dx = -radius; dx <= radius; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue
      const pos: Vec3 = [gx + dx, gy, gz + dz]
      if (!this.port.layout.inBounds(...pos) || !this.safePose(pos)) continue
      const p = this.port.layout.voxelIndex(...pos), owner = this.occupied.get(p)
      if (taken.has(p) || owner !== undefined && owner !== u.id) continue
      u.goal = p; this.dirty.add(u.id)
      return true
    }
    return false
  }
  private incapacitate(u: Unit): void {
    this.clearOrder(u); u.motion = null; u.state = 'incapacitated'; u.vy = 0
    this.release(u); this.dirty.add(u.id); this.port.emit('unitIncapacitated', { id: u.id }); this.cancelOrphanOrders()
  }
  private fall(u: Unit): void {
    this.resetRoute(u)
    u.state = 'falling'; u.motion = null
    if (u.task) { if (u.task.order.id < 0) this.targets.delete(u.task.p); u.task.claim = 0; u.task = null }
    u.vy = Math.min(512, u.vy + 24); u.progressAt = this.time
    const target = Math.max(0, u.y - u.vy)
    for (let yy = Math.ceil(u.y / 256) - 1; yy >= Math.floor(target / 256); yy--) {
      let floor = yy < 0
      for (let z = (u.z - 96) >> 8; z <= (u.z + 95) >> 8; z++) for (let x = (u.x - 96) >> 8; x <= (u.x + 95) >> 8; x++) if (this.port.registry.solid[voxelId(this.port.get(x, yy, z))]) floor = true
      if (floor) { u.y = (yy + 1) * 256; u.vy = 0; u.state = u.goal === null ? 'idle' : 'planning'; break }
    }
    if (u.state === 'falling') u.y = target
    if (u.y === 0) { u.vy = 0; u.state = u.goal === null ? 'idle' : 'planning' }
    const cells = this.body(u.x, u.y, u.z)
    if (!this.volumeFree(cells) || !this.reserve(u, cells)) this.incapacitate(u)
    this.dirty.add(u.id)
  }
  afterPhysics(): void {
    let engineeringSlots = 0, engineeringWork = 0
    this.refineWork = 0
    const wasDynamic = this.dynamicWasBusy
    const dynamic = this.port.dynamicBusy()
    // Settling physics may end transient hazards (deep water, structural checks): every failure becomes retryable.
    if (dynamic !== this.dynamicWasBusy) { this.revision++; if (!dynamic) this.policy++; this.dynamicWasBusy = dynamic }
    for (const o of [...this.reservations]) if (!o.stalled && this.time - o.progress >= STALL_TICKS && !this.tasks.some(t => t.order === o && (t.claim || t.reason === 'missing-material' || t.reason === 'missing-tool'))) { o.stalled = true; this.buildReservationsChanged(o) }
    this.time++; this.expand()
    for (const u of this.units.values()) {
      if (u.state === 'incapacitated') continue
      const stationaryValid = !u.motion && !dynamic && !wasDynamic && u.validatedWorld === this.worldRevision && u.validatedPose[0] === u.x && u.validatedPose[1] === u.y && u.validatedPose[2] === u.z
      if (!stationaryValid) {
        if (!this.volumeFree(this.body(u.x, u.y, u.z))) { this.incapacitate(u); continue }
        if (u.state === 'falling' || !u.motion && !this.hasSupport(u)) { this.fall(u); continue }
        if (!u.motion && !this.nav.stand(...this.pose(u)) && this.hasSupport(u)) {
          const from = this.position(u)
          for (let d = 0; d < 4; d++) { const p = this.nav.neighbor(from, d); if (p >= 0 && this.poseOk(u, this.port.layout.voxelCoords(p)) && this.beginMotion(u, p)) break }
          continue
        }
        u.validatedWorld = this.worldRevision; u.validatedPose[0] = u.x; u.validatedPose[1] = u.y; u.validatedPose[2] = u.z
        if (!u.motion) u.unsafeHere = !this.safePose(this.pose(u))
      }
      // A claim lapses when its unit neither moves nor works for LEASE_TICKS; a waiting flat step stops where it stands.
      if (u.task && u.state !== 'falling' && (!u.motion || u.motion.flat) && this.time - u.progressAt >= LEASE_TICKS) {
        if (u.motion) { u.motion = null; this.reserve(u, this.body(u.x, u.y, u.z)) }
        this.block(u, 'traffic'); continue
      }
      if (u.motion) {
        const m = u.motion
        // Ascent lifts above the source before translating; validate its original floor, not the interpolated height.
        const sourcePhase = m.elapsed === 0 || this.port.layout.voxelCoords(m.to)[1] * 256 > m.start[1] && u.x === m.start[0] && u.z === m.start[2]
        if (m.flat && !this.hasSupport(u) || sourcePhase && !this.hasSupport({ x: m.start[0], y: m.start[1], z: m.start[2] })) { this.fall(u); continue }
        const next = this.motionPose(m.to, m.elapsed + 1, m.ticks, m.start)
        const cells = m.flat ? walkSweep(this.port.layout, [u.x, u.y, u.z], next).filter(p => m.area!.has(p)) : m.cells
        if (!(m.flat ? this.walkable(u, cells, u.y >> 8) : this.volumeFree(cells)) || !this.poseOk(u, this.port.layout.voxelCoords(m.to))) { u.motion = null; this.reserve(u, this.body(u.x, u.y, u.z)); this.block(u, 'unsafe'); continue }
        if (m.flat && !this.reserve(u, cells)) {
          this.reserve(u, this.body(u.x, u.y, u.z)); u.wait++; u.reason = 'traffic'; this.dirty.add(u.id)
          const owner = cells.map(p => this.occupied.get(p)).find(id => id !== undefined && id !== u.id)
          const other = owner === undefined ? undefined : this.units.get(owner)
          // Break head-on symmetry: the older moving unit waits while the newer one detours.
          // A newer unit about to move keeps the right of way, but never for longer than the traffic block limit.
          const hasPriority = owner !== undefined && owner > u.id && other && (other.motion !== null || other.state === 'planning')
          if (u.wait >= 12 && (!hasPriority || u.wait >= 80)) { u.motion = null; u.path = []; u.cursor = 0; this.yield(u) }
          continue
        }
        if (u.wait || u.reason) { u.wait = 0; u.reason = undefined; this.dirty.add(u.id) }
        m.cells = cells
        m.elapsed++; [u.x, u.y, u.z] = this.motionPose(m.to, m.elapsed, m.ticks, m.start); u.progressAt = this.time
        if (m.elapsed === m.ticks) { u.motion = null; u.cursor = m.cursor; this.reserve(u, this.body(u.x, u.y, u.z)); u.state = u.goal === null && !u.task ? 'idle' : 'planning'; this.dirty.add(u.id) }
        if (u.motion) continue
      }
      if (u.state === 'blocked') {
        // A blocked unit cannot replan before its retry, so it keeps reporting why it is blocked until then.
        // Executor-level reasons are transient by nature and retry on their own; plan failures wait for a change.
        if (this.time < u.retry || u.revision === this.revision && !dynamic && u.reason !== 'traffic' && u.reason !== 'unsafe' && u.reason !== 'target-changed') continue
        u.state = 'planning'; u.reason = undefined; this.dirty.add(u.id)
      }
      // Moving out of an unsafe pose is always allowed; only staying idle there is not. Transient checks get a grace period.
      const idle = u.state === 'idle' && u.goal === null && !u.task && !u.search && !u.route && u.path[u.cursor] === undefined
      u.exposed = idle && u.unsafeHere ? u.exposed + 1 : 0
      if (u.exposed && this.time >= u.retry && (u.exposed >= 20 || !dynamic)) {
        u.search = this.request(u, [], undefined, p => this.safePose(this.port.layout.voxelCoords(p))); u.state = 'planning'; u.retry = this.time + 40; this.dirty.add(u.id); continue
      }
      if (u.state === 'working' && u.task) {
        if (this.canWork(this.pose(u), u.task)) { u.progress = Math.min(u.duration, u.progress + 1); u.progressAt = this.time }
        else this.block(u, 'unsafe')
        continue
      }
      if (u.engineering) {
        if (engineeringSlots++ >= 4) continue
        engineeringWork += u.engineering.step(Math.min(128, Math.max(0, this.searchCap - engineeringWork)))
        if (u.engineering.status === 'pending') continue
        const search = u.engineering; u.engineering = null
        if (search.status === 'found' && (!u.alternative.length || search.cost < u.alternativeCost)) { u.actions = search.actions; u.actionCursor = 0; u.path = []; u.cursor = 0; u.alternative = []; u.alternativeCost = 0 }
        else if (u.alternative.length) { u.path = u.alternative; u.cursor = 1; u.alternative = [] }
        else { this.block(u, search.status === 'limited' || u.searchLimited ? 'search-limited' : search.missingMaterial ? 'missing-material' : 'no-access'); continue }
        u.searchLimited = false
      }
      if (u.actions[u.actionCursor]) {
        const a = u.actions[u.actionCursor]!
        if (a.kind === 'walk') { const p = this.port.layout.voxelIndex(...a.pos); if (this.beginMotion(u, p)) u.actionCursor++; continue }
        const p = this.port.layout.voxelIndex(...a.pos)
        if (this.targets.has(p)) { this.block(u, 'traffic'); continue }
        const order: Order = { id: -u.id, kind: a.kind, min: a.pos, max: a.pos, voxel: a.voxel, total: 1, done: 0, pending: 1, cursor: 1, cancelled: false, ids: new Set([u.id]), priority: 128, parked: [], parkedRevision: -1, ringPending: null, rings: 0, floor: 0, ring: 0, progress: 0, stalled: false, idleSince: this.time, noCrewSince: -1 }
        const t: Task = { order, i: 0, p, pos: a.pos, expected: this.port.get(...a.pos), claim: u.id, added: this.time, failures: new Map() }
        if (this.satisfied(t)) { u.actionCursor++; continue }
        if (!this.canWork(this.pose(u), t)) { this.block(u, 'unsafe'); continue }
        this.targets.add(p); u.task = t; u.actionCursor++; u.state = 'working'; u.progress = 0; u.duration = a.kind === 'build' ? this.build[voxelId(a.voxel)]! : this.dig[voxelId(t.expected)]!; this.dirty.add(u.id); continue
      }
      if (u.search) {
        const s = u.search
        if (s.status === 'pending') continue
        u.search = null
        if (s.status === 'found') {
          u.stale = 0
          if (u.goal !== null && (u.allowDig || u.buildBlock) && s.cost > 32) { u.alternative = s.path; u.alternativeCost = s.cost; this.engineer(u); continue }
          if (u.task) {
            const p = s.path.at(-1)!, owner = this.workPositions.get(p)
            // Another unit took this pose while the search ran: search again for the poses still free.
            if (owner !== undefined && owner !== u.id) {
              const goals = this.workGoals(u, u.task)
              if (!goals.length) { this.block(u, 'traffic'); continue }
              u.workPoses = goals; this.plan(u, goals); continue
            }
            this.releaseWorkPoses(u); u.workPoses = [p]; this.workPositions.set(p, u.id)
          }
          u.path = s.path; u.cursor = 1
          if (u.route) u.route.segs = []
        }
        else if (s.status === 'stale' || s.status === 'cancelled') { u.path = []; if (s.status === 'stale') u.retry = this.time + staleBackoff(++u.stale) }
        else {
          if (u.goal !== null && (u.allowDig || u.buildBlock) && u.reason !== 'traffic') { this.engineer(u, s.status === 'limited'); continue }
          this.block(u, s.status === 'limited' ? 'search-limited' : u.reason === 'traffic' ? 'traffic' : 'no-access', s.seen); continue
        }
      }
      if (u.route && this.advanceRoute(u)) continue
      if (u.path[u.cursor] !== undefined) { this.beginPathMotion(u); continue }
      if (u.task && this.canWork(this.pose(u), u.task)) {
        u.state = 'working'; u.progress = 0; u.duration = u.task.order.kind === 'build' ? this.build[voxelId(u.task.order.voxel)]! : this.dig[voxelId(this.port.get(...u.task.pos))]!
        this.dirty.add(u.id); continue
      }
      if (u.task) { if (this.time >= u.retry) this.plan(u, this.workGoals(u, u.task)); u.state = 'planning'; continue }
      if (u.goal !== null) {
        if (this.position(u) === u.goal) {
          const [x, y, z] = this.port.layout.voxelCoords(u.goal)
          if (u.x !== x * 256 + 128 || u.y !== y * 256 || u.z !== z * 256 + 128) { this.beginMotion(u, u.goal, u.cursor); continue }
          this.port.emit('unitArrived', { id: u.id }); u.goal = null; u.state = 'idle'; this.dirty.add(u.id)
        }
        else if (this.time >= u.retry) { this.plan(u, [u.goal]); u.state = 'planning' }
      }
      // Nothing left to do (a failed or discarded escape, a sidestep without a goal): become assignable again.
      if (u.goal === null && !u.task && !u.search && !u.route && !u.motion && !u.engineering && !u.actions[u.actionCursor] && u.path[u.cursor] === undefined && u.state !== 'idle') { u.state = 'idle'; this.dirty.add(u.id) }
    }
    this.engineeringVisited = engineeringWork
    this.assign(); this.nav.step(Math.max(0, this.searchCap - engineeringWork - this.refineWork))
  }
  private escaping(u: Unit): boolean { const [x, y, z] = this.pose(u); return this.reservations.some(o => this.reservedBy(o, x, y, z, false) || this.reservedBy(o, x, y + 1, z, true)) }
  /** The flat search heuristic from the unit to its nearest goal. */
  private estimate(u: Unit, goals: readonly number[]): number {
    const [x, y, z] = this.pose(u)
    let h = Infinity
    for (const g of goals) { const [gx, gy, gz] = this.port.layout.voxelCoords(g); h = Math.min(h, (Math.abs(x - gx) + Math.abs(z - gz)) * 4 + Math.max(0, gy - y) * 2) }
    return h
  }
  /**
   * Long walks go hierarchical. Escaping a build designation, engineering (dig or build on the way) and short walks stay
   * on the flat search, like traffic detours and the exposure escape, which call `request` directly.
   */
  private plan(u: Unit, goals: readonly number[], exclude: readonly number[] = []): void {
    this.dropRoute(u)
    if (this.escaping(u) || u.allowDig || u.buildBlock || !goals.length || this.estimate(u, goals) <= HIER_MIN) { u.search = this.request(u, goals); return }
    u.escape = []; u.search = null
    u.route = this.newRoute(this.nav.route(this.position(u), goals, exclude.length ? { exclude: new Set(exclude) } : undefined), goals, exclude)
  }
  private newRoute(search: RouteSearch | GroupField, goals: readonly number[], exclude: readonly number[] = []): Route {
    if (search instanceof GroupField) { const g = this.groups.get(search); if (g) g.users++; else this.groups.set(search, { id: this.nextGroup++, users: 1 }) }
    return { search, goals: [...goals], exits: [], next: 0, last: -1, segs: [], exclude: [...exclude], finished: false, replan: false, target: null }
  }
  /** Drops the route and its segment search; a group field is cancelled when its last unit leaves it. */
  private dropRoute(u: Unit): void {
    const r = u.route
    u.segment?.cancel(); u.segment = null
    if (!r) return
    u.route = null
    if (!(r.search instanceof GroupField)) { r.search.cancel(); return }
    const g = this.groups.get(r.search)!
    if (--g.users === 0) { this.groups.delete(r.search); r.search.cancel() }
  }
  /** Claims the work pose a route ends on; false when another unit took it while the route was searched or refined. */
  private claimWorkPose(u: Unit, p: number): boolean {
    const owner = this.workPositions.get(p)
    if (owner !== undefined && owner !== u.id) return false
    this.releaseWorkPoses(u); u.workPoses = [p]; this.workPositions.set(p, u.id); return true
  }
  /** Plans the task again from where the unit stands, toward the work poses still free. Always waits this tick. */
  private replanTask(u: Unit): boolean {
    const goals = this.workGoals(u, u.task!)
    u.path = []; u.cursor = 0
    if (!goals.length) { this.block(u, 'traffic'); return true }
    this.releaseWorkPoses(u); u.workPoses = goals; this.plan(u, goals); u.state = 'planning'; this.dirty.add(u.id); return true
  }
  /**
   * Moves a standing unit along its route: adopts the result, keeps two refined segments ahead, and replans from where it
   * stands when a region it is about to cross changed or its path was replaced. True when the unit waits this tick.
   */
  private advanceRoute(u: Unit): boolean {
    const r = u.route!, s = r.search
    if (s.status === 'pending') return true
    if (s.status !== 'found') {
      this.dropRoute(u); u.path = []; u.cursor = 0
      if (s.status === 'stale') { u.retry = this.time + staleBackoff(++u.stale); return false }
      // A group field that cannot serve falls back to the unit's own route.
      if (s instanceof GroupField || s.status === 'cancelled') { this.plan(u, r.goals, r.exclude); return true }
      this.block(u, s.status === 'limited' ? 'search-limited' : 'no-access', s.seen); return true
    }
    const here = this.position(u)
    if (r.last < 0) {
      if (s instanceof GroupField && !s.next(here)) { this.plan(u, r.goals); return true }
      if (u.task && s instanceof RouteSearch && !this.claimWorkPose(u, s.goal)) return this.replanTask(u)
      u.stale = 0; r.last = here; u.path = [here]; u.cursor = 1
    }
    if (u.segment && u.segment.status !== 'pending') {
      const seg = u.segment, target = r.target!
      u.segment = null; r.target = null
      if (seg.status === 'found') this.appendSegment(u, r, seg.path, target)
      else if (seg.status !== 'stale' && seg.status !== 'cancelled') {
        // Live policy or a confined detour cut the segment: route around that exit, or finish the walk on a flat search.
        if (target.key < 0) { this.dropRoute(u); return false }
        r.exclude.push(r.search.region(target.region)!.exits[splitKey(target.key)[1]]!.from); r.replan = true
      }
    }
    const ahead = () => { let n = 0; for (const g of r.segs) if (g.end >= u.cursor) n++; return n }
    // A path cut or replaced under the route (reservations, a sidestep), or an edit on a segment still to walk.
    if (u.path[u.cursor] === undefined && !r.finished && !u.segment && here !== r.last) r.replan = true
    for (const g of r.segs) if (g.end >= u.cursor && this.nav.revisions[g.region] !== g.epoch) r.replan = true
    while (!r.replan && !r.finished && !u.segment && ahead() < 2 && this.refineNext(u, r));
    if (r.replan) { if (u.task) return this.replanTask(u); const { goals, exclude } = r; u.path = []; u.cursor = 0; this.plan(u, goals, exclude); return true }
    if (r.finished && !u.segment && u.path[u.cursor] === undefined) { this.dropRoute(u); return false }
    return u.path[u.cursor] === undefined
  }
  /** Refines the next segment by field descent, or starts a confined search for it; true when a segment was appended. */
  private refineNext(u: Unit, r: Route): boolean {
    const steps = Math.min(SEGMENT_STEPS, Math.floor((this.searchCap - this.refineWork - 1) / 5))
    if (steps < 1) return false
    const s = r.search, L = this.port.layout, from = r.last, index = this.nav.tileOfPose(from), region = s.region(index)
    if (!region || region.epoch !== this.nav.revisions[index]) { r.replan = true; return false }
    let key = -1
    if (s instanceof RouteSearch) key = r.next < s.keys.length ? s.keys[r.next]! : -1
    else {
      const n = s.next(from)
      // The goal region: the unit's own destination is reached by a flat search, not the field to the nearest goal.
      if (!n || n.exit < 0) { if (n) r.finished = true; else r.replan = true; return false }
      key = n.exit
    }
    const field = key >= 0 ? splitKey(key)[1] : (s as RouteSearch).goalFields.get(index)
    if (field === undefined || key >= 0 && splitKey(key)[0] !== index) { r.replan = true; return false }
    const target = { key, region: index, epoch: region.epoch }
    const d = descend(region, field, from, p => this.poseOk(u, L.voxelCoords(p)) && (this.occupied.get(p) ?? u.id) === u.id, L, steps)
    this.refineWork += d.ops
    if (d.ok || d.cut) { this.appendSegment(u, r, d.path, d.ok ? target : null); return d.ok }
    const goals = key >= 0 ? [region.exits[splitKey(key)[1]]!.from] : r.goals.filter(p => this.nav.tileOfPose(p) === index)
    u.segment = this.nav.request(from, goals, undefined, { region: index }); r.target = target
    return false
  }
  /** Appends a refined path, then the crossing into the next region (or, for the goal, ends the route there). */
  private appendSegment(u: Unit, r: Route, path: readonly number[], target: Route['target']): void {
    for (let i = 1; i < path.length; i++) u.path.push(path[i]!)
    r.last = u.path.at(-1)!
    const index = this.nav.tileOfPose(path[0]!)
    r.segs = r.segs.filter(g => g.end >= u.cursor)
    r.segs.push({ end: u.path.length - 1, region: index, epoch: target?.epoch ?? this.nav.revisions[index]! })
    if (!target) return
    if (target.key < 0) { r.finished = true; if (u.task && !this.claimWorkPose(u, r.last)) r.replan = true; return }
    const exit = r.search.region(target.region)!.exits[splitKey(target.key)[1]]!
    u.path.push(exit.to); r.last = exit.to; r.exits.push(target.key); r.next++
    r.segs[r.segs.length - 1]!.end = u.path.length - 1
  }
  private engineer(u: Unit, searchLimited = false): void {
    u.searchLimited = searchLimited
    u.engineering = new EngineeringSearch({
      layout: this.port.layout, get: this.port.get, solid: v => this.port.registry.solid[voxelId(v)] === 1,
      digTicks: (pos, v) => u.allowDig && (!this.tools[voxelId(v)] || u.tools.has(this.tools[voxelId(v)]!)) && !this.overlaps(pos[0], pos[1] + 1, pos[2]) ? this.dig[voxelId(v)]! : 0,
      buildTicks: this.build[u.buildBlock]!, safe: pos => this.port.safe(...pos) && !this.port.hazard(...pos) && !this.reservedPose(...pos), editable: pos => !this.inBuildBox(pos),
      capacityRemaining: this.capacity - this.stockCount(u), drop: v => this.drops[voxelId(v)]!,
    }, this.pose(u), this.port.layout.voxelCoords(u.goal!), u.stock.get(u.buildBlock) ?? 0, u.buildBlock)
    u.state = 'planning'; this.dirty.add(u.id)
  }
  view(id: number): WorkerView | undefined {
    const u = this.units.get(id)
    return u && { id, available: u.available, x256: u.x, y256: u.y, z256: u.z, facing: u.facing, state: u.state, order: u.task?.order.id ?? 0, progress: u.progress, duration: u.duration, ...(u.reason && { reason: u.reason }), stock: [...u.stock].map(([block, count]) => ({ block, count })) }
  }
  viewDrops(): { pos: Vec3; block: number; count: number }[] { return [...this.loose].flatMap(([p, pile]) => [...pile].map(([block, count]) => ({ pos: this.port.layout.voxelCoords(p), block, count }))) }
  publication(versions?: Uint32Array, tick = 0): WorkerTick {
    const poses = new Int32Array(this.units.size * 9)
    let at = 0
    for (const u of this.units.values()) { poses.set([u.id, u.x, u.y, u.z, u.facing, WORKER_STATES.indexOf(u.state), u.task?.order.id ?? 0, u.progress, u.duration], at); at += 9 }
    const details = [...this.dirty].flatMap(id => { const view = this.view(id); return view ? [view] : [] }); this.dirty.clear()
    const barriers = this.barriers.map(({ unit, pos }) => ({ unit, pos, chunks: this.port.layout.chunksAround(...pos).map(chunk => ({ chunk, version: versions?.[chunk] ?? 0 })) })); this.barriers = []
    const drops = [...this.dirtyDrops.values()]; this.dirtyDrops.clear()
    return { tick, poses, details, barriers, drops, orders: this.orders.map(o => ({ id: o.id, kind: o.kind, min: o.min, max: o.max, voxel: o.voxel, total: o.total, done: o.done, pending: o.pending, cancelled: o.cancelled, ...(o.reason && { reason: o.reason }), effectivePriority: this.effective(o) })),
      stats: { units: this.units.size, orders: this.orders.filter(o => !o.cancelled && o.done < o.total).length, tasks: this.tasks.length, searches: this.nav.pending + [...this.units.values()].filter(u => u.engineering !== null).length, visited: this.nav.visited + this.engineeringVisited + this.refineWork, mutations: this.mutations, navBytes: this.nav.bytes, cacheTiles: this.nav.cacheTiles, regionBytes: this.nav.regions.bytes, regions: this.nav.regions.size } }
  }
  mixState(mix: (n: number) => void): void {
    const reason = (r: WorkBlockReason | undefined) => mix(r === undefined ? -1 : ['no-access', 'missing-material', 'missing-tool', 'unsafe', 'traffic', 'search-limited', 'target-changed'].indexOf(r))
    const numbers = (values: readonly number[]) => { mix(values.length); for (const n of values) mix(n) }
    const order = (o: Order) => {
      mix(o.id); mix(o.kind === 'dig' ? 1 : 2); mix(o.cursor); mix(o.total); mix(o.done); mix(o.pending); mix(o.cancelled ? 1 : 0); mix(o.voxel); mix(o.priority); reason(o.reason)
      numbers(o.min); numbers(o.max); mix(o.ids?.size ?? -1); for (const id of o.ids ?? []) mix(id); numbers(o.parked); mix(o.parkedRevision); mix(o.rings); mix(o.floor); mix(o.ring); mix(o.progress); mix(o.stalled ? 1 : 0); numbers([...(o.ringPending ?? [])]); mix(o.idleSince); mix(o.noCrewSince)
    }
    const failures = (map: Map<number, TaskFailure>) => {
      mix(map.size)
      for (const [id, f] of [...map].sort((a, b) => a[0] - b[0])) { mix(id); mix(f.origin); mix(f.policy); mix(f.nav); mix(f.retry); reason(f.reason); mix(f.tiles.size); for (const [ti, rev] of f.tiles) { mix(ti); mix(rev) } }
    }
    const task = (t: Task) => {
      mix(t.p); mix(t.i); numbers(t.pos); mix(t.expected); mix(t.claim); mix(t.added); reason(t.reason); order(t.order)
      failures(t.failures)
    }
    mix(this.nextUnit); mix(this.nextOrder); mix(this.time); mix(this.revision); mix(this.worldRevision); mix(this.policy); mix(this.assignmentCursor); mix(this.dynamicWasBusy ? 1 : 0)
    mix(this.units.size)
    for (const u of this.units.values()) {
      mix(u.id); mix(u.x); mix(u.y); mix(u.z); mix(u.facing); mix(WORKER_STATES.indexOf(u.state)); mix(u.goal ?? -1); mix(u.cursor); mix(u.progress); mix(u.duration); mix(u.vy); mix(u.retry); mix(u.revision); mix(u.wait)
      mix(u.available ? 1 : 0); numbers(u.escape.map(o => o.id)); mix(u.exposed); mix(u.unsafeHere ? 1 : 0); mix(u.stale); mix(u.progressAt); reason(u.reason); mix(u.validatedWorld); numbers(u.validatedPose)
      mix(u.tools.size); for (const t of u.tools) { mix(t.length); for (const c of t) mix(c.charCodeAt(0)) }
      mix(u.stock.size)
      for (const [b, n] of u.stock) { mix(b); mix(n) }
      numbers(u.path); numbers(u.workPoses); numbers(u.cells); numbers(u.alternative)
      mix(u.task ? 1 : 0); if (u.task) task(u.task)
      mix(u.motion ? 1 : 0)
      if (u.motion) { mix(u.motion.from); mix(u.motion.to); mix(u.motion.cursor); mix(u.motion.flat ? 1 : 0); mix(u.motion.elapsed); mix(u.motion.ticks); numbers(u.motion.start); numbers(u.motion.cells); numbers([...(u.motion.area ?? [])]) }
      mix(u.route ? 1 : 0)
      if (u.route) {
        const r = u.route, s = r.search
        mix(s instanceof GroupField ? this.groups.get(s)!.id : -1); mix(STATUSES.indexOf(s.status))
        if (s instanceof RouteSearch) { mix(s.cost); numbers(s.keys); mix(s.goal) }
        numbers(r.goals); numbers(r.exits); mix(r.next); mix(r.last); numbers(r.exclude); mix(r.finished ? 1 : 0); mix(r.replan ? 1 : 0)
        mix(r.segs.length); for (const g of r.segs) { mix(g.end); mix(g.region); mix(g.epoch) }
        mix(r.target ? r.target.key : -2); mix(r.target?.region ?? -1); mix(r.target?.epoch ?? -1)
      }
      mix(u.segment ? 1 : 0); u.segment?.mixState(mix)
      mix(u.search ? 1 : 0)
      u.search?.mixState(mix)
      mix(u.engineering ? 1 : 0); u.engineering?.mixState(mix); mix(u.searchLimited ? 1 : 0); mix(u.allowDig ? 1 : 0); mix(u.buildBlock); mix(u.actionCursor); mix(u.alternativeCost); mix(u.actions.length)
      for (const a of u.actions) { mix(a.kind === 'dig' ? 1 : a.kind === 'build' ? 2 : 3); mix(a.voxel); for (const p of a.pos) mix(p) }
    }
    mix(this.orders.length); for (const o of this.orders) order(o)
    mix(this.tasks.length); for (const t of this.tasks) task(t)
    mix(this.parkedFailures.size); for (const [p, h] of this.parkedFailures) { mix(p); reason(h.reason); failures(h.failures) }
    numbers([...this.targets]); mix(this.workPositions.size); for (const [p, id] of this.workPositions) { mix(p); mix(id) }
    mix(this.occupied.size); for (const [p, id] of this.occupied) { mix(p); mix(id) }
    mix(this.loose.size); for (const [p, pile] of this.loose) { mix(p); mix(pile.size); for (const [b, n] of pile) { mix(b); mix(n) } }
    this.nav.mixState(mix)
  }
}
