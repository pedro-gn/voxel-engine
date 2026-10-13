import type { BlockRegistry } from '../../blocks/registry.ts'
import type { Layout } from '../../world/layout.ts'
import { voxelId } from '../../world/voxel.ts'
import { raycast } from '../../interact/raycast.ts'
import type { Command, Vec3 } from '../commands.ts'
import { NavigationSystem, type PathSearch } from '../navigation/navigation.ts'
import { EngineeringSearch, type RouteAction } from '../navigation/engineering.ts'
import { RouteSearch } from '../navigation/routeSearch.ts'
import { GroupField, startClusters } from '../navigation/groupField.ts'
import { exitKey, landing, reverseField, slotOf, splitKey, type Region } from '../navigation/regions.ts'
import { descend, nextHop } from '../navigation/refine.ts'
import { walkSweep } from './walkSweep.ts'
import { ReservationTable } from './reservations.ts'
import { SLEEP_TICKS, Sleepers } from './sleepers.ts'
import { SpaceTimeSearch, type SpaceTimePort } from './spaceTime.ts'
import { NO_CREW_TICKS, effectivePriority, parkChoice, shares } from './frontier.ts'
import type { WorkersSnapshot } from './snapshot.ts'
import { WORKER_STATES, type WorkerCommand, type WorkerOptions, type WorkerState, type WorkerTick, type WorkerView, type WorkBlockReason, type WorkOrderView } from './types.ts'

export interface WorkerPort {
  layout: Layout; registry: BlockRegistry
  get(x: number, y: number, z: number): number
  /** Allocation/preflight first; resource callback immediately after the grid write, before physics hooks. */
  edit(pos: Vec3, expected: number, value: number, commit: () => void): boolean
  safe(x: number, y: number, z: number): boolean
  /** safe() without its head-cell rule: poses a unit caught by water over its head may walk through on its way out. */
  wadeable?(x: number, y: number, z: number): boolean
  /** Water above the feet of pose (x, y, z), in 1/256 block. */
  depth?(x: number, y: number, z: number): number
  hazard(x: number, y: number, z: number): boolean
  dynamicBusy(): boolean
  emit(type: string, payload: unknown): void
  /** The voxel filling the whole chunk at (x, y, z) when the chunk is uniform; lets region builds skip empty tiles. */
  uniform?(x: number, y: number, z: number): number | undefined
}
/**
 * `world` and `policy`: the world revision and policy its cells and target were validated against when it began (world
 * -1 when physics was busy then). While both still hold and physics stays quiet, those checks cannot fail. `axis`: the
 * direction of a centered one-block flat step (see axisStep), else -1. Both derived, not hashed.
 */
type Motion = { from: number; to: number; cursor: number; start: [number, number, number]; flat: boolean; elapsed: number; ticks: number; cells: number[]; area: Set<number> | null; world: number; policy: number; axis: number }
/**
 * What a moving unit has reserved: through tick t, ending on Q8 pose `pose`, with path nodes from `cursor` still to
 * project. `end` and `first` are the tick the in-flight motion ends and the node the projection steps to next; a
 * motion that begins there toward that single node keeps the projection. `path` and `motion` mark what it was made for.
 */
interface Projection {
  cursor: number; pose: [number, number, number]; t: number; end: number; first: number; path: readonly number[]; motion: Motion | null; stood: boolean
  /** Path length it was made for, and the tick it started standing at the path's end (-1 before): nodes appended later resume from there. */
  len: number; endAt: number
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
  motion: Motion | null
  projection: Projection | null
  /** The first tick and owner the projection (or a stalled next step) could not reserve. */
  conflict: { t: number; owner: number } | null
  /**
   * Ticks without progress: progress is work, or standing closer to the target (goal or task) than ever before since
   * it was set, so being pushed back and forth does not count. Ages the unit's priority.
   */
  stuck: number; best: number; bestTarget: number
  /** A pending space-time repair, the route it rejoins and where and when it starts. */
  repair: SpaceTimeSearch | null; repairFrom: { path: readonly number[]; cursor: number; start: number; startTick: number; at: number } | null; repairAfter: number
  /** A repair plan: stand on path[i] through untils[i] before stepping on. Valid only for the path it was made for. */
  schedule: { path: readonly number[]; untils: number[] } | null
  /** The unit that took this one's right of way, and until when this one keeps yielding to it. */
  yieldTo: number; yieldUntil: number
  /** Until when others yield to this unit: it keeps projecting its route even while it waits for them. */
  passUntil: number
  vy: number; wait: number; retry: number; revision: number; reason?: WorkBlockReason
  /** Build designations the unit started its current route inside; only these may be crossed on the way out. */
  escape: Order[]
  /** Consecutive ticks spent idle on a pose the unit may not stay on. */
  exposed: number
  /** Whether the stationary pose is one the unit may not stay on; refreshed with the stationary validation. */
  unsafeHere: boolean
  /** Caught by water over its head: it walks out through poses it may wade, until it stands on a safe one. */
  wadingOut: boolean
  /** Consecutive stale searches; each one doubles the wait before the next attempt. */
  stale: number
  /** The tick of the last move or work progress; a task claim lapses LEASE_TICKS after it. */
  progressAt: number
  /** A hierarchical route being walked; its refined segments are appended to `path`, two ahead of the unit. */
  route: Route | null
  /** Region-confined flat search refining a segment that the field descent could not. */
  segment: PathSearch | null
  /** The path keepRight last looked at and its length then: only nodes appended since are looked at again. */
  laned: { path: readonly number[]; len: number } | null
}
/**
 * last: pose where the refined path ends; segs: refined segments by end index in `path`, with the region revision they
 * were refined on; exits: exit keys refined so far; target: what `segment` refines (an exit key, or -1 for the goal) and
 * the record it refines in; goalField: the cost to the goals over a goal region's current record, when the search's own
 * is missing or stale (records and fields are functions of a tile's revision: derived, not hashed); recovered: regions
 * that changed since the search read them where the unit took a way on, and hop: the region of the last way on taken.
 */
interface Route {
  search: RouteSearch | GroupField; goals: number[]; exits: number[]; last: number
  segs: { end: number; region: number; epoch: number }[]; exclude: number[]; finished: boolean; replan: boolean
  target: { key: number; region: number; epoch: number; record: Region } | null
  goalField: { record: Region; field: Uint16Array } | null
  recovered: number[]; hop: number
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
/** Repairs started per tick, path nodes a repair may rejoin, and ticks without progress per point of aged priority. */
const MAX_REPAIRS = 8, REPAIR_SPAN = 24, STUCK_STEP = 20
/** While a unit with nothing to walk waits for its route or group field, repairs get what is left shifted right by this (an eighth). */
const REPAIR_SHARE_WAITING_SHIFT = 3
/** Ticks a preempting unit that stands still lets the owner start leaving first; ticks the owner then keeps yielding. */
const PREEMPT_DELAY = 8, YIELD_TICKS = 200
/** Ticks before a unit that adopted a repair plan may repair again; ticks stuck before it falls back to detours and traffic blocks. */
const REPAIR_COOLDOWN = 8, STUCK_LIMIT = 160
/** Ticks a repair may stay pending before it is dropped. */
const REPAIR_TICKS = 4
/** How far an idle unit may walk to clear someone's route when no refuge is in reach of one window. */
const MAKE_WAY_RADIUS = 16
/**
 * A unit enters water only with its head dry (safe(), the region layer); once its feet are in water it may carry on through
 * water up to this deep (1/256 block), so a lake rising a little over the one-block limit does not strand it mid-crossing.
 */
const WADE_ON_DEPTH = 384
/** Flat heuristic estimate above which a unit walks a hierarchical route; steps one field descent may take. */
export const HIER_MIN = 48 * 4
const SEGMENT_STEPS = 256
/** Regions a route may recover in from costs priced one region ahead before it plans anew. */
const MAX_RECOVERIES = 16
const STATUSES = ['pending', 'found', 'unreachable', 'limited', 'stale', 'cancelled'] as const
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const
/** The planar direction to the right of each of DIRS: right of (dx, dz) is (-dz, dx). The opposite of d is d ^ 1. */
const RIGHT = [2, 3, 1, 0] as const
/** Path nodes a lane change must run beside the old path, at least, for the units to pass each other. */
const LANE_MIN = 4
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
  /** Space-time plan of every unit: moving units project their route, still ones hold their body. */
  readonly table = new ReservationTable(32)
  /** Units queued behind another unit, asleep until it moves, their tile changes or a deadline passes. */
  private readonly sleepers = new Sleepers()
  private readonly sleepEnabled: boolean
  /** Units that are not moving, working or idle that take decisions per tick; the rest wait, oldest first. */
  private readonly decisionCap: number
  /** Units deferred by the decision budget, with the tick each was first deferred. */
  private deferred = new Map<number, number>()
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
  /** Bumped whenever a unit's destination changes; the goal index is rebuilt from it. */
  private goalsVersion = 0
  private goalIndex: { version: number; count: Map<number, number> } | null = null
  /** Index deltas of the cells a centered one-block axis step sweeps in each of its ticks, by direction * 4 + tick. */
  private stepPatterns = new Map<number, number[]>()
  /** Units walking each group field, and the field's hash id in creation order. */
  private groups = new Map<GroupField, { id: number; users: number }>()
  private nextGroup = 1
  private dynamicWasBusy = false
  readonly maxUnits: number
  private readonly searchCap: number
  private readonly prebuildCap: number
  private readonly assignmentCap: number | undefined
  private readonly assignmentShare: number
  private readonly commitCap: number
  private readonly capacity: number
  private readonly maxOrders: number
  constructor(port: WorkerPort, options: WorkerOptions = {}) {
    this.port = port
    this.maxUnits = options.maxUnits ?? 1000; this.searchCap = options.searchCap ?? 4096; this.prebuildCap = options.prebuildCap ?? 1024; this.sleepEnabled = options.sleep !== false; this.decisionCap = options.decisionCap ?? 256
    this.assignmentCap = options.assignmentCap; this.assignmentShare = options.assignmentShare ?? 8; this.commitCap = options.commitCap ?? 16
    this.capacity = options.inventoryCapacity ?? 512; this.maxOrders = options.maxOrders ?? 128
    for (const [name, n] of Object.entries({ maxUnits: this.maxUnits, searchCap: this.searchCap, prebuildCap: this.prebuildCap, decisionCap: this.decisionCap, assignmentCap: this.assignmentCap ?? 16, assignmentShare: this.assignmentShare, commitCap: this.commitCap, capacity: this.capacity, maxOrders: this.maxOrders, maxSearchNodes: options.maxSearchNodes ?? 16384 })) {
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
    this.sleepers.wakeTile(this.nav.tileOf(x, y, z))
    const R = this.port.registry, a = voxelId(old), b = voxelId(value)
    // Liquid entering, leaving or changing kind in a cell moves the head-cell rule of the pose below and the feet rule of
    // the pose there: the region layer reads both as geometry.
    if ((R.liquid[a] || R.liquid[b]) && a !== b && !R.solid[a] && !R.solid[b]) this.nav.invalidateLiquid(x, y, z)
    // Liquid flow is dynamic state, retried while dynamicBusy(); only geometry and solid material swaps wake failures.
    if (R.solid[a] !== R.solid[b] || R.structural[a] !== R.structural[b] || R.falls[a] !== R.falls[b]) { this.nav.invalidate(x, y, z, R.solid[a] !== R.solid[b], R.falls[a] !== R.falls[b]); this.worldRevision++; this.revision++ }
    else if (a !== b && !R.liquid[a] && !R.liquid[b]) this.revision++
  }
  invalidateAll(): void {
    this.sleepers.wakeAll()
    // Routes refine from region records of the old world, and the reset restarts tile revisions at 0, so an old record
    // could pass for current: drop every route and its refined path still to walk; the unit plans again where it stands.
    for (const u of this.units.values()) if (u.route || u.segment) { this.dropRoute(u); u.path = u.path.slice(0, u.cursor) }
    this.nav.reset(); this.revision++; this.worldRevision++; this.policy++
  }
  geometryChanged(old: Uint16Array, value: Uint16Array): boolean {
    const R = this.port.registry
    for (let i = 0; i < old.length; i++) {
      const a = voxelId(old[i]!), b = voxelId(value[i]!)
      // Liquid presence and kind are region geometry too (the head-cell and feet rules of NavigationSystem.regionStand).
      if (R.solid[a] !== R.solid[b] || R.structural[a] !== R.structural[b] || R.falls[a] !== R.falls[b] || (R.liquid[a] || R.liquid[b]) && a !== b) return true
    }
    return false
  }
  replaceChunk(ci: number, geometry: boolean): void {
    this.sleepers.wakeAll()
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
    if (cells.length !== u.cells.length || cells.some((p, i) => p !== u.cells[i])) this.sleepers.wakeOwner(u.id)
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
  /** A pose a unit wading out of water over its head may take: it stands, no hazard, and safe but for water in the head cell. */
  private wadeOut(pos: Vec3): boolean { return this.nav.stand(...pos) && (this.port.wadeable?.(...pos) ?? false) && !this.port.hazard(...pos) }
  /** Whether the unit's feet are in water: it may then carry on through water up to WADE_ON_DEPTH. */
  private wading(u: Unit): boolean { return this.port.registry.liquid[voxelId(this.port.get(...this.pose(u)))] === 1 }
  private wadeOn(pos: Vec3): boolean { return this.wadeOut(pos) && (this.port.depth?.(...pos) ?? Infinity) <= WADE_ON_DEPTH }
  private poseOk(u: Unit, pos: Vec3): boolean { if (u.wadingOut && this.wadeOut(pos) || this.wading(u) && this.wadeOn(pos)) return true; return u.escape.length ? this.nav.stand(...pos) && this.exitAllowed(this.port.layout.voxelIndex(...pos), u.escape) : this.safePose(pos) }
  /** `also` narrows the live policy for this search (it never admits more). */
  private request(u: Unit, goals: readonly number[], blocked?: ReadonlySet<number>, accept?: (p: number) => boolean, also?: (p: number) => boolean): PathSearch {
    const [x, y, z] = this.pose(u), escape = this.reservations.filter(o => this.reservedBy(o, x, y, z, false) || this.reservedBy(o, x, y + 1, z, true))
    u.escape = escape
    const policy = escape.length ? (p: number) => this.exitAllowed(p, escape)
      : this.wading(u) ? (p: number) => this.nav.allowed(p) || this.wadeOn(this.port.layout.voxelCoords(p))
      : also && ((p: number) => this.nav.allowed(p))
    return this.nav.request(this.position(u), goals, blocked, { ...(policy && { allowed: also ? (p: number) => policy(p) && also(p) : policy }), ...(accept && { accept }) })
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
    this.resetRoute(u); u.goal = null; u.stale = 0; this.goalsVersion++
    if (u.task) { if (u.task.order.id < 0) this.targets.delete(u.task.p); u.task.claim = 0; u.task = null }
    u.reason = undefined; u.wait = 0
    if (!u.motion && u.state !== 'incapacitated' && u.state !== 'falling') u.state = 'idle'
    this.dirty.add(u.id)
  }
  private newUnit(id: number, x: number, y: number, z: number, tools: Iterable<string>, stock: Map<number, number>): Unit {
    return { id, x, y, z, facing: 0, state: 'idle', tools: new Set(tools), stock,
      goal: null, search: null, path: [], cursor: 0, task: null, progress: 0, duration: 0, cells: [], motion: null, vy: 0, wait: 0, retry: 0, revision: -1,
      allowDig: false, buildBlock: 0, engineering: null, searchLimited: false, actions: [], actionCursor: 0, alternative: [], alternativeCost: 0, workPoses: [], validatedWorld: -1, validatedPose: [0, 0, 0], available: true, escape: [], exposed: 0, unsafeHere: false, wadingOut: false, stale: 0, progressAt: this.time, route: null, segment: null,
      projection: null, conflict: null, stuck: 0, best: 0, bestTarget: -1, repair: null, repairFrom: null, repairAfter: 0, schedule: null, yieldTo: 0, yieldUntil: 0, passUntil: 0, laned: null }
  }
  /** Plan deviation 6: durable state only; navigation, searches, reservations, claims and failure histories are rebuilt. */
  snapshot(): WorkersSnapshot {
    return {
      nextUnit: this.nextUnit, nextOrder: this.nextOrder, time: this.time, assignmentCursor: this.assignmentCursor,
      units: [...this.units.values()].map(u => {
        // As clearOrder: a flat motion stops where the unit stands (a supported pose); a vertical step goes back to its start.
        let x = u.x, y = u.y, z = u.z
        if (u.motion && !u.motion.flat) [x, y, z] = u.motion.start
        const state: WorkerState = u.state === 'falling' || u.state === 'incapacitated' ? u.state : u.goal === null ? 'idle' : 'planning'
        return { id: u.id, x, y, z, facing: u.facing, state, vy: u.vy, tools: [...u.tools], stock: [...u.stock], goal: u.goal, available: u.available, allowDig: u.allowDig, buildBlock: u.buildBlock }
      }),
      orders: this.orders.map(o => ({
        id: o.id, kind: o.kind, min: [...o.min] as Vec3, max: [...o.max] as Vec3, voxel: o.voxel, total: o.total, done: o.done, pending: o.pending, cancelled: o.cancelled,
        ...(o.reason && { reason: o.reason }), cursor: o.cursor, ids: o.ids ? [...o.ids] : null, priority: o.priority,
        parked: [...o.parked], ringPending: o.ringPending ? [...o.ringPending] : null,
        rings: o.rings, floor: o.floor, ring: o.ring, progress: o.progress, stalled: o.stalled, idleSince: o.idleSince, noCrewSince: o.noCrewSince,
      })),
      tasks: this.tasks.filter(t => t.order.id > 0).map(t => ({ order: t.order.id, i: t.i, expected: t.expected, added: t.added, ...(t.reason && { reason: t.reason }) })),
      loose: [...this.loose].map(([p, pile]) => [p, [...pile]] as [number, [number, number][]]),
    }
  }
  /** Into an empty system, before the first tick: units plan again where they stand, frontier tasks re-expand. */
  restore(s: WorkersSnapshot): void {
    this.sleepers.wakeAll(); this.deferred.clear()
    if (this.units.size || this.orders.length || this.loose.size) throw new Error('workers restore needs an empty system')
    this.nextUnit = s.nextUnit; this.nextOrder = s.nextOrder; this.time = s.time; this.assignmentCursor = s.assignmentCursor
    for (const o of s.orders) {
      this.orders.push({ ...o, min: [...o.min] as Vec3, max: [...o.max] as Vec3, ids: o.ids ? new Set(o.ids) : null, parked: [...o.parked], parkedRevision: -1, ringPending: o.ringPending ? Int32Array.from(o.ringPending) : null })
    }
    // The frontier comes back as expand() builds it, unclaimed: a build's current ring is already exposed, and putting its
    // cells back among the parked ones would leave them behind fresh cells of later rings (they never expose first).
    for (const ts of s.tasks) {
      const o = this.orders.find(o => o.id === ts.order)
      if (!o) throw new Error(`restored task names unknown order ${ts.order}`)
      const pos = this.cell(o, ts.i), p = this.port.layout.voxelIndex(...pos)
      const t: Task = { order: o, i: ts.i, pos, p, expected: ts.expected, claim: 0, added: ts.added, failures: new Map(), ...(ts.reason && { reason: ts.reason }) }
      this.targets.add(p); this.tasks.push(t); this.index(t)
    }
    for (const v of s.units) {
      const u = this.newUnit(v.id, v.x, v.y, v.z, v.tools, new Map(v.stock))
      Object.assign(u, { facing: v.facing, state: v.state, vy: v.vy, goal: v.goal, available: v.available, allowDig: v.allowDig, buildBlock: v.buildBlock })
      if (!this.reserve(u, this.body(u.x, u.y, u.z))) throw new Error(`restored unit ${u.id} overlaps another unit`)
      this.units.set(u.id, u); this.dirty.add(u.id)
    }
    for (const [p, pile] of s.loose) {
      this.loose.set(p, new Map(pile))
      for (const [block, count] of pile) this.dirtyDrops.set(`${p}:${block}`, { pos: this.port.layout.voxelCoords(p), block, count })
    }
    this.buildReservationsChanged()
    this.goalsVersion++
  }
  command(command: Command): void {
    // Any order, cancel, spawn or despawn may change what a sleeper waits for.
    this.sleepers.wakeAll()
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
      const u = this.newUnit(this.nextUnit, c.pos[0] * 256 + 128, c.pos[1] * 256, c.pos[2] * 256 + 128, c.tools ?? [], stock)
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
      this.goalsVersion++
      units.forEach((u, i) => { this.clearOrder(u); if (u.state !== 'incapacitated') { u.available = true; u.goal = destinations[i]!; u.allowDig = c.allowDig === true; u.buildBlock = c.buildBlock ?? 0; u.state = u.motion ? 'walking' : 'planning'; u.retry = 0; u.revision = -1 } })
      // Units that would each plan a long route share one reverse field from their destinations, one per cluster of starts.
      const members = units.filter(u => u.state !== 'incapacitated' && !u.motion && this.routable(u) && this.estimate(u, [u.goal!]) > HIER_MIN)
      for (const cluster of startClusters(members.map(u => this.position(u)), this.port.layout)) {
        if (cluster.length < 2) continue
        const group = cluster.map(i => members[i]!), field = this.nav.group(group.map(u => u.goal!), group.map(u => this.position(u)))
        for (const u of group) { u.route = this.newRoute(field, [u.goal!]); u.escape = [] }
      }
    } else if (c.type === 'unitCancel') for (const u of units) { this.clearOrder(u); u.available = false }
    else if (c.type === 'unitDespawn') { for (const u of units) { this.clearOrder(u); this.release(u); this.table.releaseOwner(u.id); this.units.delete(u.id); this.dirty.delete(u.id); this.deferred.delete(u.id); for (const t of this.tasks) t.failures.delete(u.id); for (const h of this.parkedFailures.values()) h.failures.delete(u.id) }; this.cancelOrphanOrders() }
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
  /** Whether another unit holds pose p with no end in the reservation table (it stands there). */
  private poseHeld(p: number, u: Unit): boolean { const h = this.table.holder(p); return h !== 0 && h !== u.id }
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
    u.search?.cancel(); u.search = null; u.path = []; u.cursor = 0; u.progress = 0; u.escape = []; u.repair = null; u.repairFrom = null
  }
  private block(u: Unit, reason: WorkBlockReason, tiles?: ReadonlyMap<number, number>): void {
    // Traffic says nothing about the way: a moving unit keeps its settled route and carries on from where it stands when
    // it retries, instead of planning a route of its own (a crowd of those queues behind one another's searches).
    const keep = reason === 'traffic' && !u.task && u.route && u.route.search.status !== 'pending' ? u.route : null
    if (keep) u.route = null
    this.resetRoute(u); u.stale = 0
    if (keep) { u.route = keep; keep.last = -1; keep.target = null; keep.segs = []; keep.finished = false }
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
    const L = this.port.layout, y = u.y >> 8, to = u.path[u.cursor]!, back = u.path[u.cursor - 1]
    // Traffic can stop a step between nodes, off the path: the unit walks straight to the next node, or back onto the
    // node it stepped from or toward (that line is the stopped step's own), and waits for bodies in the way like any
    // step instead of failing the neighbour check.
    const here = this.position(u)
    if (back !== undefined && here !== back) {
      for (const [p, cursor] of [[to, u.cursor + 1], [back, u.cursor]] as const) {
        const [x, ty, z] = L.voxelCoords(p), cells = walkSweep(L, [u.x, u.y, u.z], [x * 256 + 128, u.y, z * 256 + 128])
        if (ty === y && this.walkable(u, cells, y)) return this.beginMotion(u, p, cursor, cells)
      }
      // Neither in reach (another level): a route carries on from where the unit stands.
      if (u.route && !DIRS.some((_, d) => this.nav.neighbor(here, d) === to)) { this.reseat(u, u.route, here); return false }
    }
    // A blocked next step needs traffic arbitration, not repeated long visibility probes; a repair plan goes node by node.
    if (u.wait || u.cursor < this.scheduled(u)) return this.beginMotion(u, to)
    let end = u.cursor
    while (end < u.path.length && end < u.cursor + WALK_LOOKAHEAD && L.voxelCoords(u.path[end]!)[1] === y) end++
    // Bound both lookahead and probes; never smooth across stairs or engineering edits.
    const stride = Math.max(1, Math.ceil((end - u.cursor) / WALK_PROBES))
    // Through a two-wide passage a shortcut stays on the path's own nodes, so it never cuts across the oncoming lane.
    const own = this.inPassage(u.path, u.cursor - 1, end) ? new Set(u.path.slice(Math.max(0, u.cursor - 1), end)) : null
    for (let i = end - 1; i > u.cursor; i -= stride) {
      const to = u.path[i]!, [x, , z] = L.voxelCoords(to)
      const cells = walkSweep(L, [u.x, u.y, u.z], [x * 256 + 128, u.y, z * 256 + 128])
      if (cells.some(p => this.occupied.has(p) && this.occupied.get(p) !== u.id) || !this.walkable(u, cells, y)) continue
      if (own && cells.some(p => L.voxelCoords(p)[1] === y && !own.has(p))) continue
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
    const ticks = this.stepTicks(start, to)
    let cells: number[], area: Set<number> | null = null
    if (flat) {
      const sweep = visibleCells ?? walkSweep(this.port.layout, start, [tx * 256 + 128, u.y, tz * 256 + 128])
      if (!visibleCells && !this.walkable(u, sweep, y)) {
        // Stopped off-center (traffic cut a step short), the body sweeps a neighbour cell: re-center first, then step.
        if (from !== to && ((u.x & 255) !== 128 || (u.z & 255) !== 128)) return this.beginMotion(u, from, u.cursor)
        this.block(u, 'unsafe'); return false
      }
      const valid = new Set(sweep); area = valid
      cells = walkSweep(this.port.layout, start, this.motionPose(to, 1, ticks, start)).filter(p => valid.has(p))
    } else cells = this.verticalCells(to, ticks, start)
    if (!this.volumeFree(cells)) { this.block(u, 'unsafe'); return false }
    // A vertical action holds all its cells for its whole duration; a flat step checks each tick as it goes.
    if (!this.tableFree(u, cells, this.time + 1, flat ? 1 : ticks) || !this.reserve(u, cells)) {
      u.wait++; u.reason = 'traffic'; this.dirty.add(u.id)
      if (u.wait >= 12 && this.escalates(u) && !this.waitsFor(u, cells, this.time + 1)) this.yield(u)
      const other = this.blocker(u, cells, this.time + 1)
      if (this.sleepEnabled && other && !u.repair && u.reason === 'traffic' && this.waitsFor(u, cells, this.time + 1)) this.sleepers.sleep(u.id, this.time, other.id, this.nav.tileOfPose(this.position(u)), this.time + SLEEP_TICKS)
      return false
    }
    // Owning the first tick now keeps projections made later this tick from claiming the cells it just took.
    for (let t = this.time + 1; t <= this.time + (flat ? 1 : ticks); t++) this.table.reserve(u.id, t, cells)
    u.wait = 0; u.reason = undefined; u.motion = { from, to, cursor, start, flat, elapsed: 0, ticks, cells, area, world: this.dynamicWasBusy ? -1 : this.worldRevision, policy: this.policy, axis: flat ? this.axisStep(start, to) : -1 }; u.facing = tx !== x ? tx > x ? 1 : 3 : tz > z ? 0 : 2; u.state = 'walking'; this.dirty.add(u.id); return true
  }
  private stepTicks(start: readonly [number, number, number], to: number): number {
    const [tx, ty, tz] = this.port.layout.voxelCoords(to), y = start[1] >> 8
    return ty * 256 === start[1] ? Math.max(1, Math.ceil(ceilSqrt((tx * 256 + 128 - start[0]) ** 2 + (tz * 256 + 128 - start[2]) ** 2) / WALK_SPEED)) : 4 + (ty > y ? 2 : y - ty)
  }
  private verticalCells(to: number, ticks: number, start: [number, number, number]): number[] {
    const set = new Set<number>()
    for (let q = 0; q <= ticks * 4; q++) for (const p of this.body(...this.motionPose(to, q / 4, ticks, start))) set.add(p)
    return [...set]
  }
  /** Whether the reservation table leaves the cells to the unit for n ticks from tick `from`. */
  private tableFree(u: Unit, cells: readonly number[], from: number, n: number): boolean {
    for (let t = from; t < from + n; t++) if (!this.table.free(u.id, t, cells)) return false
    return true
  }
  /**
   * Whether a unit waiting on traffic falls back to today's detour, sidestep and traffic block: only once the
   * cooperative layer (lanes, preemption, repairs) has left it without progress for STUCK_LIMIT ticks.
   */
  private escalates(u: Unit): boolean { return u.stuck >= STUCK_LIMIT }
  /** The first other unit whose body or reservation at tick t is on these cells. */
  private blocker(u: Unit, cells: readonly number[], t: number): Unit | undefined {
    for (const p of cells) {
      const id = this.occupied.get(p) ?? (this.table.owner(p, t) || undefined), o = id === undefined || id === u.id ? undefined : this.units.get(id)
      if (o) return o
    }
    return undefined
  }
  /**
   * Whether u should wait for the unit blocking these cells instead of detouring: it is yielding to u, or u walks
   * behind it (a queue is not a conflict; overtaking takes the oncoming lane).
   */
  private waitsFor(u: Unit, cells: readonly number[], t: number): boolean {
    const o = this.blocker(u, cells, t)
    return !!o && (o.yieldTo === u.id && this.time < o.yieldUntil || this.follows(u, o))
  }
  private yield(u: Unit): void {
    // Partway through a climb or a drop the unit's cell may stand nowhere: a search from there would prove nothing.
    if (u.motion && !u.motion.flat) return
    const from = this.position(u), intended = u.path[u.cursor], owner = intended === undefined ? undefined : this.occupied.get(intended)
    const other = owner === undefined ? undefined : this.units.get(owner)
    if (other && this.outranks(other, u) && (other.motion !== null || other.state === 'planning' && other.task !== null) && u.wait < 80) return // an active unit with the right of way wins for a while; idle bodies still require a detour
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
      // A detour in a two-wide passage keeps out of the oncoming lane, except to reach its goal there or to pass a body
      // that is not on its way.
      const d = this.heading(u), ends = new Set(goals), keep = d < 0 || other && !this.onItsWay(other) ? undefined : (p: number) => ends.has(p) || !this.oncomingLane(p, d)
      u.search?.cancel(); u.search = this.request(u, goals, blocked, undefined, keep); u.path = []; u.cursor = 0; u.wait = 0; u.reason = 'traffic'; u.state = 'planning'; this.dirty.add(u.id); return
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
      u.goal = p; this.goalsVersion++; this.dirty.add(u.id)
      return true
    }
    return false
  }
  private incapacitate(u: Unit): void {
    this.sleepers.wakeOwner(u.id); this.sleepers.wake(u.id)
    this.clearOrder(u); u.motion = null; u.state = 'incapacitated'; u.vy = 0
    this.release(u); this.table.releaseOwner(u.id); u.projection = null; u.conflict = null; this.dirty.add(u.id); this.port.emit('unitIncapacitated', { id: u.id }); this.cancelOrphanOrders()
  }
  private fall(u: Unit): void {
    this.sleepers.wakeOwner(u.id); this.sleepers.wake(u.id)
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
    this.time++; this.table.advance(this.time); this.expand(); this.sleepers.expire(this.time)
    // FIFO decision budget: units deferred longest go first, then the others in id order while slots are left.
    const waiting = [...this.deferred].sort((a, b) => a[1] - b[1] || a[0] - b[0]), serve = new Set(waiting.slice(0, this.decisionCap).map(e => e[0]))
    let slots = this.decisionCap - serve.size
    const deferredNext = new Map<number, number>()
    for (const u of this.units.values()) {
      if (u.state === 'incapacitated') continue
      // A dozing unit still runs the safety checks below (body, support, its pose, its claim's lease); it skips decisions.
      const dozing = this.sleepers.dozing(u.id, this.time)
      const stationaryValid = !u.motion && !dynamic && !wasDynamic && u.validatedWorld === this.worldRevision && u.validatedPose[0] === u.x && u.validatedPose[1] === u.y && u.validatedPose[2] === u.z
      if (!stationaryValid) {
        if (!this.volumeFree(this.body(u.x, u.y, u.z))) { this.incapacitate(u); continue }
        if (u.state === 'falling' || !u.motion && !this.hasSupport(u)) { this.fall(u); continue }
        if (!u.motion && !this.nav.stand(...this.pose(u)) && this.hasSupport(u)) {
          const from = this.position(u)
          // A step off the path: the cursor stays, and the path resumes from wherever the unit then stands.
          if (dozing) this.sleepers.wake(u.id)
          for (let d = 0; d < 4; d++) { const p = this.nav.neighbor(from, d); if (p >= 0 && this.poseOk(u, this.port.layout.voxelCoords(p)) && this.beginMotion(u, p, u.cursor)) break }
          continue
        }
        u.validatedWorld = this.worldRevision; u.validatedPose[0] = u.x; u.validatedPose[1] = u.y; u.validatedPose[2] = u.z
        if (!u.motion) { u.unsafeHere = !this.safePose(this.pose(u)); if (!u.unsafeHere && u.wadingOut) { u.wadingOut = false; this.dirty.add(u.id) } }
      }
      // A claim lapses when its unit neither moves nor works for LEASE_TICKS; a waiting flat step stops where it stands.
      if (u.task && u.state !== 'falling' && (!u.motion || u.motion.flat) && this.time - u.progressAt >= LEASE_TICKS) {
        if (u.motion) { u.motion = null; this.reserve(u, this.body(u.x, u.y, u.z)) }
        this.sleepers.wake(u.id); this.block(u, 'traffic'); continue
      }
      // A waiting flat step needs its support like any motion (the motion branch below checks it for awake units).
      if (dozing) { if (u.motion?.flat && !this.hasSupport(u)) this.fall(u); continue }
      if (u.motion) {
        const m = u.motion
        // Ascent lifts above the source before translating; validate its original floor, not the interpolated height.
        const sourcePhase = m.elapsed === 0 || this.port.layout.voxelCoords(m.to)[1] * 256 > m.start[1] && u.x === m.start[0] && u.z === m.start[2]
        if (m.flat && !this.hasSupport(u) || sourcePhase && !this.hasSupport({ x: m.start[0], y: m.start[1], z: m.start[2] })) { this.fall(u); continue }
        const next = this.motionPose(m.to, m.elapsed + 1, m.ticks, m.start)
        const cells = m.flat ? this.motionCells(m, m.elapsed, [u.x, u.y, u.z], next) : m.cells
        // The whole sweep and the target were checked when the motion began; only a changed world can fail them now.
        const known = !dynamic && !wasDynamic && m.world === this.worldRevision && m.policy === this.policy
        if (!known && (!(m.flat ? this.walkable(u, cells, u.y >> 8) : this.volumeFree(cells)) || !this.poseOk(u, this.port.layout.voxelCoords(m.to)))) { u.motion = null; this.reserve(u, this.body(u.x, u.y, u.z)); this.block(u, 'unsafe'); continue }
        if (m.flat && (!this.table.free(u.id, this.time, cells) || !this.reserve(u, cells))) {
          this.reserve(u, this.body(u.x, u.y, u.z)); u.wait++; u.reason = 'traffic'; this.dirty.add(u.id)
          const owner = cells.map(p => this.occupied.get(p) ?? (this.table.owner(p, this.time) || undefined)).find(id => id !== undefined && id !== u.id)
          const other = owner === undefined ? undefined : this.units.get(owner)
          // Break head-on symmetry: the unit with the right of way keeps it while the other detours,
          // but never for longer than the traffic block limit.
          const hasPriority = other !== undefined && this.outranks(other, u) && (other.motion !== null || other.state === 'planning')
          if (u.wait >= 12 && this.escalates(u) && (!hasPriority || u.wait >= 80) && !this.waitsFor(u, cells, this.time)) { u.motion = null; u.path = []; u.cursor = 0; this.yield(u) }
          // Queued behind a unit on its way (or one yielding to it): sleep until that unit's cells change.
          if (this.sleepEnabled && u.motion && !u.repair && other && this.waitsFor(u, cells, this.time)) this.sleepers.sleep(u.id, this.time, other.id, this.nav.tileOfPose(this.position(u)), this.time + SLEEP_TICKS)
          continue
        }
        if (u.wait || u.reason) { u.wait = 0; u.reason = undefined; this.dirty.add(u.id) }
        m.cells = cells
        m.elapsed++; [u.x, u.y, u.z] = this.motionPose(m.to, m.elapsed, m.ticks, m.start); u.progressAt = this.time
        if (m.elapsed === m.ticks) { u.motion = null; u.cursor = m.cursor; this.reserve(u, this.body(u.x, u.y, u.z)); u.state = u.goal === null && !u.task ? 'idle' : 'planning'; this.dirty.add(u.id) }
        if (u.motion) continue
      }
      // Idle units with nothing to do and working units are cheap and exempt; anyone else takes a decision slot.
      if (u.state !== 'idle' && u.state !== 'working' && !this.routine(u)) {
        if (this.deferred.has(u.id) ? !serve.has(u.id) : slots-- <= 0) { deferredNext.set(u.id, this.deferred.get(u.id) ?? this.time); continue }
      }
      // Caught by water over its head: no pose next to it may be safe, so it first wades out to the nearest safe pose; and
      // again if the water rose over it where the last escape ended.
      if (u.unsafeHere && !u.motion && !u.search && !u.engineering && u.path[u.cursor] === undefined && u.state !== 'working' && u.state !== 'falling' && this.time >= u.retry && this.headUnder(u) && (this.port.depth?.(...this.pose(u)) ?? Infinity) > WADE_ON_DEPTH) {
        // Its route would only plan on from here again: drop it, and plan anew once out.
        this.resetRoute(u); u.wadingOut = true; u.path = []; u.cursor = 0
        u.search = this.nav.request(this.position(u), [], undefined, { allowed: p => this.wadeOut(this.port.layout.voxelCoords(p)), accept: p => this.safePose(this.port.layout.voxelCoords(p)) })
        u.state = 'planning'; u.reason = undefined; u.retry = this.time + 40; this.dirty.add(u.id); continue
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
          // A detour boxed in by bodies proves nothing about the terrain: it waits on traffic.
          this.block(u, s.restricted || u.reason === 'traffic' ? 'traffic' : s.status === 'limited' ? 'search-limited' : 'no-access', s.seen); continue
        }
      }
      if (u.route && this.advanceRoute(u)) continue
      if (u.path[u.cursor] !== undefined) this.keepRight(u)
      if (u.repair || this.waitsHere(u)) continue
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
          this.port.emit('unitArrived', { id: u.id }); u.goal = null; this.goalsVersion++; u.state = 'idle'; this.dirty.add(u.id)
        }
        else if (this.time >= u.retry) { this.plan(u, [u.goal]); u.state = 'planning' }
      }
      // Nothing left to do (a failed or discarded escape, a sidestep without a goal): become assignable again.
      if (u.goal === null && !u.task && !u.search && !u.route && !u.motion && !u.engineering && !u.actions[u.actionCursor] && u.path[u.cursor] === undefined && u.state !== 'idle') { u.state = 'idle'; this.dirty.add(u.id) }
    }
    this.deferred = deferredNext
    for (const u of this.units.values()) {
      if (u.state === 'incapacitated') continue
      const target = u.task ? u.task.p : u.goal ?? -1
      if (target !== u.bestTarget) { u.bestTarget = target; u.best = 0x7fffffff }
      if (target < 0 || u.state === 'working') u.stuck = 0
      else {
        const [x, y, z] = this.pose(u), [tx, ty, tz] = this.port.layout.voxelCoords(target), d = Math.abs(x - tx) + Math.abs(y - ty) + Math.abs(z - tz)
        if (d < u.best) { u.best = d; u.stuck = 0 } else u.stuck++
      }
      if (this.sleepers.dozing(u.id, this.time)) {
        // Asleep: no projection. `stuck` rose above as for any unit that did not get closer; a waiting step counts its wait
        // here, where the skipped part of the first pass would have. Wake one tick before a threshold acts (the claim's
        // lease is checked in the first pass).
        if (u.motion) u.wait++
        // A sleeper whose cells are no longer its own next tick (its hold or standing entries lapsed) wakes, so it plans in the
        // table again and no one plans through it.
        if (u.wait + 1 === 12 || u.wait + 1 === 80 || u.stuck + 1 === STUCK_LIMIT || u.cells.some(p => this.table.owner(p, this.time + 1) !== u.id)) this.sleepers.wake(u.id)
        continue
      }
      if (this.projecting(u)) this.project(u); else this.holdHere(u)
    }
    // While a unit with nothing to walk waits for its route or group field (a long move that has not started), repairs get
    // an eighth of what is left; while only other queries wait (detours, short searches), half; else all of it. A unit
    // that cannot start is worse off than one whose plan needs a repair; traffic detours keep the half they need.
    const left = Math.max(0, this.searchCap - engineeringWork - this.refineWork)
    let starving = false
    for (const u of this.units.values()) if (u.path[u.cursor] === undefined && !u.motion && u.route?.search.status === 'pending') { starving = true; break }
    const repairWork = this.cooperate(starving ? left >> REPAIR_SHARE_WAITING_SHIFT : this.nav.pending ? left >> 1 : left)
    this.engineeringVisited = engineeringWork + repairWork
    const rest = Math.max(0, this.searchCap - engineeringWork - this.refineWork - repairWork)
    this.assign(); this.nav.step(rest)
    // What the tick left unused builds regions ahead, around the units first; with no unit and no query, nothing needs them.
    if (rest > this.nav.visited && (this.units.size || this.nav.pending)) {
      const anchors = new Set<number>()
      for (const u of this.units.values()) if (u.state !== 'incapacitated') anchors.add(this.nav.tileOfPose(this.position(u)))
      this.nav.prebuild(this.nav.warmed ? Math.min(rest - this.nav.visited, this.prebuildCap) : rest - this.nav.visited, [...anchors], this.time)
    }
  }
  /** Whether liquid fills the cell at the unit's head. */
  private headUnder(u: Unit): boolean { const [x, y, z] = this.pose(u); return y + 1 < this.port.layout.size[1] && this.port.registry.liquid[voxelId(this.port.get(x, y + 1, z))] === 1 }
  /**
   * A unit whose turn is routine takes no decision slot: it waits for its retry or its search, or walks on along a path it
   * has (holding it back would stutter its walk).
   */
  private routine(u: Unit): boolean {
    if (u.state === 'blocked') return this.time < u.retry
    if (u.search?.status === 'pending' || u.engineering?.status === 'pending') return true
    return u.path[u.cursor] !== undefined && !u.search && !u.repair && !u.engineering && !u.actions[u.actionCursor]
  }
  /** Whether the unit may plan on the region layer: no engineering, no designation to escape, not standing on sand. */
  private routable(u: Unit): boolean { return !u.allowDig && !u.buildBlock && !this.escaping(u) && this.nav.regionStand(...this.pose(u)) }
  private escaping(u: Unit): boolean { const [x, y, z] = this.pose(u); return this.reservations.some(o => this.reservedBy(o, x, y, z, false) || this.reservedBy(o, x, y + 1, z, true)) }
  /** The flat search heuristic from the unit to its nearest goal. */
  private estimate(u: Unit, goals: readonly number[]): number { return this.estimateFrom(this.pose(u), goals) }
  private estimateFrom([x, y, z]: Vec3, goals: readonly number[]): number {
    let h = Infinity
    for (const g of goals) { const [gx, gy, gz] = this.port.layout.voxelCoords(g); h = Math.min(h, (Math.abs(x - gx) + Math.abs(z - gz)) * 4 + Math.max(0, gy - y) * 2) }
    return h
  }
  /**
   * Long walks go hierarchical. Escaping a build designation, standing on sand, engineering (dig or build on the way)
   * and short walks stay on the flat search, like traffic detours and the exposure escape, which call `request` directly.
   */
  private plan(u: Unit, goals: readonly number[], exclude: readonly number[] = []): void {
    this.dropRoute(u)
    // Wading where the region layer has no pose (water up to its head): a long walk first wades, toward the goals, to the
    // nearest pose the region layer has that is nearer the goals than the unit is, and routes from there when it plans
    // again (a shore behind it may be cut off from the goals by the water it stands in).
    if (goals.length && this.wading(u) && !this.nav.regionStand(...this.pose(u)) && !u.allowDig && !u.buildBlock && this.estimate(u, goals) > HIER_MIN) {
      const here = this.estimate(u, goals)
      u.search = this.request(u, goals, undefined, p => { const c = this.port.layout.voxelCoords(p); return this.nav.regionStand(...c) && this.safePose(c) && this.estimateFrom(c, goals) < here }); return
    }
    if (!this.routable(u) || !goals.length || this.estimate(u, goals) <= HIER_MIN) { u.search = this.request(u, goals); return }
    u.escape = []; u.search = null
    u.route = this.newRoute(this.nav.route(this.position(u), goals, exclude.length ? { exclude: new Set(exclude) } : undefined), goals, exclude)
  }
  private newRoute(search: RouteSearch | GroupField, goals: readonly number[], exclude: readonly number[] = []): Route {
    if (search instanceof GroupField) { const g = this.groups.get(search); if (g) g.users++; else this.groups.set(search, { id: this.nextGroup++, users: 1 }) }
    return { search, goals: [...goals], exits: [], last: -1, segs: [], exclude: [...exclude], finished: false, replan: false, target: null, goalField: null, recovered: [], hop: -1 }
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
   * Moves a standing unit along its route: adopts the result and keeps two refined segments ahead. When a region it is
   * about to cross changed, or its path was replaced, it carries on from where it stands, and when a segment fails it
   * takes another way on from the segment's start: both read the route's own costs (`nextHop`), so only a unit with no
   * way on left plans a new route. True when the unit waits this tick.
   */
  private advanceRoute(u: Unit): boolean {
    const r = u.route!, s = r.search
    if (s.status === 'pending') return true
    // A group field cut by its node cap still serves: units it missed find no way on and plan their own route.
    if (s.status !== 'found' && !(s instanceof GroupField && s.status === 'limited')) {
      // Read before dropRoute, which cancels the search: an unreachable route must block, not replan every tick.
      const status = s.status
      this.dropRoute(u); u.path = []; u.cursor = 0
      if (status === 'stale') { u.retry = this.time + staleBackoff(++u.stale); return false }
      // A group field that cannot serve falls back to the unit's own route.
      if (s instanceof GroupField || status === 'cancelled') { if (u.task) return this.replanTask(u); this.plan(u, r.goals, r.exclude); return true }
      this.block(u, status === 'limited' ? 'search-limited' : 'no-access', s.seen); return true
    }
    const here = this.position(u)
    if (r.last < 0) {
      if (u.task && s instanceof RouteSearch && !this.claimWorkPose(u, s.goal)) return this.replanTask(u)
      u.stale = 0; this.reseat(u, r, here)
    }
    if (u.segment && u.segment.status !== 'pending') {
      const seg = u.segment, target = r.target!
      u.segment = null; r.target = null
      // A path replaced while the segment was searched no longer ends where the segment starts: the segment goes.
      if (seg.status === 'found') { if (u.path.at(-1) === seg.path[0]) this.appendSegment(u, r, seg.path, target) }
      else if (seg.status !== 'stale' && seg.status !== 'cancelled') {
        // Live policy or a confined detour cut the segment: go on around that exit, or finish the walk on a flat search.
        if (target.key < 0) { this.dropRoute(u); return false }
        r.exclude.push(target.record.exits[splitKey(target.key)[1]]!.from)
      }
    }
    const ahead = () => { let n = 0; for (const g of r.segs) if (g.end >= u.cursor) n++; return n }
    // A path cut or replaced under the route (reservations, a sidestep), or an edit on a segment still to walk.
    if (u.path[u.cursor] === undefined && !r.finished && !u.segment && here !== r.last) this.reseat(u, r, here)
    if (r.segs.some(g => g.end >= u.cursor && this.nav.revisions[g.region] !== g.epoch)) this.reseat(u, r, here)
    // Segments continue from r.last: only while the path still ends there. A refuge or a sidestep that replaced the
    // path ends elsewhere; the unit walks it first and the route carries on from where it then stands.
    while (!r.replan && !r.finished && !u.segment && u.path.at(-1) === r.last && ahead() < 2 && this.refineNext(u, r));
    if (r.replan) { if (u.task) return this.replanTask(u); const { goals, exclude } = r; u.path = []; u.cursor = 0; this.plan(u, goals, exclude); return true }
    if (r.finished && !u.segment && u.path[u.cursor] === undefined) { this.dropRoute(u); return false }
    return u.path[u.cursor] === undefined
  }
  /**
   * Carries the route on from `here`: the path still to walk is dropped and refinement starts again from the unit's pose.
   * Traffic or an edit brought this, not the route's own costs, so the recoveries so far show no loop: they restart (a
   * unit pushed back into a changed region it had left recovers there again instead of planning a new route).
   */
  private reseat(u: Unit, r: Route, here: number): void {
    u.segment?.cancel(); u.segment = null; r.target = null; r.finished = false
    u.path = [here]; u.cursor = 1; r.last = here; r.segs = []; r.recovered = []; r.hop = -1
  }
  /** A tile's record at its current revision: the search's own, the store's, or built on the refinement budget (undefined until done). */
  private regionAt(s: RouteSearch | GroupField, index: number): Region | undefined {
    const own = s.region(index)
    if (own && own.epoch === this.nav.revisions[index]) return own
    const { region, used } = this.nav.regionNow(index, this.searchCap - this.refineWork)
    this.refineWork += used
    return region
  }
  /** The cost to the route's goals over a goal region's record: the search's own field, or one computed on this record. */
  private goalField(r: Route, region: Region): Uint16Array | undefined {
    const s = r.search, own = s.region(region.index) === region ? s.goalFields.get(region.index) : undefined
    if (own) return own
    if (r.goalField?.record === region) return r.goalField.field
    const goals = (s instanceof GroupField ? s.goals : r.goals).filter(p => this.nav.tileOfPose(p) === region.index)
    if (!goals.length) return undefined
    const field = reverseField(region, goals, this.port.layout)
    this.refineWork += region.poses.length * 5; r.goalField = { record: region, field }
    return field
  }
  /**
   * Refines the next segment by field descent, or starts a confined search for it; true when a segment was appended.
   * The way on is the cheapest by the route's own costs from where the path ends; no way on left means a new route.
   */
  private refineNext(u: Unit, r: Route): boolean {
    if (this.searchCap - this.refineWork <= 5) return false
    const s = r.search, L = this.port.layout, from = r.last, index = this.nav.tileOfPose(from), region = this.regionAt(s, index)
    // The tile changed and its record is being built: the unit waits for it.
    if (!region) return false
    const slot = slotOf(region, from, L), goal = slot < 0 ? undefined : this.goalField(r, region)
    const hop = slot < 0 ? null : nextHop(s, region, slot, L, r.exclude, goal)
    if (hop) this.refineWork += hop.ops
    // The route's costs past a changed region were priced through it and can lead back: coming back to recover in it
    // again, or recovering too often, plans anew.
    const own = s.region(index), changed = own !== undefined && own !== region, back = changed && index !== r.hop && r.recovered.includes(index)
    if (!hop || back || changed && r.recovered.length >= MAX_RECOVERIES) { r.replan = true; return false }
    if (changed && !r.recovered.includes(index)) r.recovered.push(index)
    r.hop = index
    // A group field's goal: the unit's own destination is reached by a flat search, not the field to the nearest goal.
    if (hop.e < 0 && s instanceof GroupField) { r.finished = true; return false }
    const steps = Math.min(SEGMENT_STEPS, Math.floor((this.searchCap - this.refineWork - 1) / 5))
    if (steps < 1) return false
    const target = { key: hop.e < 0 ? -1 : exitKey(index, hop.e), region: index, epoch: region.epoch, record: region }
    const d = descend(region, hop.e < 0 ? goal! : hop.e, from, p => this.poseOk(u, L.voxelCoords(p)) && (this.occupied.get(p) ?? u.id) === u.id, L, steps, hop.e < 0 ? undefined : region.exits[hop.e])
    this.refineWork += d.ops
    if (d.ok || d.cut) { this.appendSegment(u, r, d.path, d.ok ? target : null); return d.ok }
    const crossings = hop.e >= 0 ? region.exits[hop.e]!.crossings : null
    const goals = crossings ? Array.from({ length: crossings.length >> 1 }, (_, i) => crossings[2 * i]!) : r.goals.filter(p => this.nav.tileOfPose(p) === index)
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
    // The unit crosses at the crossing of the run its segment reached.
    const exit = target.record.exits[splitKey(target.key)[1]]!, to = landing(exit, r.last)
    u.path.push(to); r.last = to; r.exits.push(target.key)
    r.segs[r.segs.length - 1]!.end = u.path.length - 1
  }
  /** A motion that advanced or began this tick; a paused one waits in place like a unit without a motion. */
  private moving(u: Unit): boolean { return u.motion !== null && u.wait === 0 }
  /** Units that plan ahead in the table: moving ones, those standing still on a repair plan's schedule, and those others yield to. */
  private projecting(u: Unit): boolean { return this.moving(u) || !u.motion && this.waitsHere(u) || this.time < u.passUntil && (u.motion !== null || u.path[u.cursor] !== undefined) }
  private untilAt(u: Unit, i: number): number | undefined { const s = u.schedule; return s && s.path === u.path ? s.untils[i] : undefined }
  /** Number of leading path nodes the current repair plan schedules. */
  private scheduled(u: Unit): number { const s = u.schedule; return s && s.path === u.path ? s.untils.length : 0 }
  private waitsHere(u: Unit): boolean { return u.cursor > 0 && (this.untilAt(u, u.cursor - 1) ?? -1) > this.time }
  private priority(u: Unit): number { return (u.task ? this.effective(u.task.order) : 128) + Math.min(64, Math.floor(u.stuck / STUCK_STEP)) }
  /** Tie-breaker that changes every 64 ticks, so no id always wins. */
  private rotation(u: Unit): number { return ((u.id * 2654435761) ^ (this.time >> 6)) >>> 0 }
  /** The right-of-way order: higher aged priority, then the lower rotation, then the lower id. */
  private outranks(a: Unit, b: Unit): boolean {
    const pa = this.priority(a), pb = this.priority(b)
    if (pa !== pb) return pa > pb
    const ra = this.rotation(a), rb = this.rotation(b)
    return ra !== rb ? ra < rb : a.id < b.id
  }
  /** Reserves cells at tick t, or records the first foreign owner there as the unit's conflict. */
  private claim(u: Unit, t: number, cells: readonly number[]): boolean {
    if (this.table.free(u.id, t, cells)) { this.table.reserve(u.id, t, cells); return true }
    let owner = 0
    for (const p of cells) { const o = this.table.owner(p, t); if (o && o !== u.id) { owner = o; break } }
    u.conflict = { t, owner }; return false
  }
  /**
   * Extends a unit's reservations to `time + window` with the executor's own motion model: the in-flight motion tick by
   * tick, then the remaining path nodes one step at a time (standing through a repair plan's scheduled ticks), then its
   * body standing at the end of the path. It stops at the first tick another owner has (the conflict) and resumes from
   * there next tick.
   */
  private project(u: Unit): void {
    this.extend(u)
    // A unit whose projection cannot leave the current tick (it waits for the cells ahead) still holds its body.
    if (u.projection!.t > this.time) this.table.releaseHold(u.id); else this.table.hold(u.id, u.cells)
  }
  private extend(u: Unit): void {
    const m = u.motion, T = this.time, L = this.port.layout, limit = T + this.table.window
    let pr = u.projection
    // A motion that begins exactly where and when the projection stepped to its next node keeps what it reserved.
    if (m && pr && pr.motion !== m && pr.path === u.path && T === pr.end && m.cursor === pr.first + 1 && m.to === u.path[pr.first] && m.elapsed === 0) {
      pr.motion = m; pr.end = T + m.ticks; pr.first = m.cursor; if (pr.cursor < m.cursor) pr.cursor = m.cursor
    }
    // Nodes appended to the same path (a route refined segment by segment) resume from where it stood at the old end.
    if (pr && pr.path === u.path && u.path.length !== pr.len) {
      if (u.path.length < pr.len) pr = null
      else { if (pr.endAt >= 0) { this.table.releaseFrom(u.id, pr.endAt + 1); pr.t = pr.endAt; pr.endAt = -1; pr.stood = false } pr.len = u.path.length }
    }
    if (pr && (pr.motion !== m || pr.path !== u.path || pr.t < T)) pr = null
    if (!pr) {
      this.table.releaseFrom(u.id, T + 1)
      const cursor = m ? m.cursor : u.cursor
      pr = u.projection = { cursor, pose: [u.x, u.y, u.z], t: T, end: m ? T + m.ticks - m.elapsed : T, first: cursor, path: u.path, motion: m, stood: false, len: u.path.length, endAt: -1 }
    }
    u.conflict = null
    if (pr.stood) { this.table.releaseFrom(u.id, pr.t + 1); pr.stood = false }
    if (m) while (pr.t < pr.end && pr.t < limit) {
      const e = m.elapsed + pr.t - T, a = this.motionPose(m.to, e, m.ticks, m.start), b = this.motionPose(m.to, e + 1, m.ticks, m.start)
      if (!this.claim(u, pr.t + 1, m.flat ? this.motionCells(m, e, a, b) : m.cells)) return this.stand(u, pr)
      pr.t++; pr.pose = b
    }
    while (pr.t < limit) {
      const to = u.path[pr.cursor], start = pr.pose
      if (to === undefined && pr.endAt < 0) pr.endAt = pr.t
      if (to === undefined || pr.t < (this.untilAt(u, pr.cursor - 1) ?? -1)) { if (!this.claim(u, pr.t + 1, this.body(...start))) return this.stand(u, pr); pr.t++; continue }
      const ticks = this.stepTicks(start, to), [tx, , tz] = L.voxelCoords(to), from = pr.t
      if (L.voxelCoords(to)[1] * 256 === start[1]) {
        const axis = this.axisStep(start, to)
        const area = axis >= 0 ? null : new Set(walkSweep(L, start, [tx * 256 + 128, start[1], tz * 256 + 128]))
        for (let e = 0; e < ticks; e++) {
          const cells = area ? walkSweep(L, this.motionPose(to, e, ticks, start), this.motionPose(to, e + 1, ticks, start)).filter(p => area.has(p)) : this.stepCellsAt(start, to, axis, e)
          if (!this.claim(u, from + e + 1, cells)) { this.table.releaseFrom(u.id, from + 1); return this.stand(u, pr) }
        }
      } else {
        const cells = this.verticalCells(to, ticks, start)
        for (let e = 1; e <= ticks; e++) if (!this.claim(u, from + e, cells)) { this.table.releaseFrom(u.id, from + 1); return this.stand(u, pr) }
      }
      pr.t = from + ticks; pr.pose = this.motionPose(to, ticks, ticks, start); pr.cursor++
    }
  }
  /** The cells a flat motion sweeps from pose a (its tick e) to pose b (tick e + 1), within its validated area. */
  private motionCells(m: Motion, e: number, a: readonly [number, number, number], b: readonly [number, number, number]): number[] {
    return m.axis >= 0 ? this.stepCellsAt(m.start, m.to, m.axis, e) : walkSweep(this.port.layout, a, b).filter(p => m.area!.has(p))
  }
  /**
   * The direction of a one-block flat step from the center of a cell to a planar neighbour's center, with room above
   * for the body; -1 otherwise.
   */
  private axisStep(start: readonly [number, number, number], to: number): number {
    if ((start[0] & 255) !== 128 || (start[2] & 255) !== 128 || (start[1] & 255) !== 0 || (start[1] >> 8) + 1 >= this.port.layout.size[1]) return -1
    return this.stepDir(this.port.layout.voxelIndex(start[0] >> 8, start[1] >> 8, start[2] >> 8), to)
  }
  /**
   * The cells walkSweep gives (in its order) for tick e of a centered one-block step in direction d, clipped to the
   * step's own sweep. The sweep is the same up to translation for every such step, so its index deltas are kept.
   */
  private stepCellsAt(start: [number, number, number], to: number, d: number, e: number): number[] {
    const L = this.port.layout, a = L.voxelIndex(start[0] >> 8, start[1] >> 8, start[2] >> 8)
    let deltas = this.stepPatterns.get(d * 4 + e)
    if (!deltas) {
      const [tx, , tz] = L.voxelCoords(to), area = new Set(walkSweep(L, start, [tx * 256 + 128, start[1], tz * 256 + 128]))
      const cells = walkSweep(L, this.motionPose(to, e, 4, start), this.motionPose(to, e + 1, 4, start)).filter(p => area.has(p))
      deltas = cells.map(p => p - a); this.stepPatterns.set(d * 4 + e, deltas)
    }
    return deltas.map(dl => a + dl)
  }
  /**
   * After a conflict the unit will wait where its projection stopped: it reserves standing there for as long as that is
   * free, beyond the frontier, so others do not plan through it. The next extension drops these entries first.
   */
  private stand(u: Unit, pr: Projection): void {
    const cells = this.body(...pr.pose), limit = this.time + this.table.window
    for (let t = pr.t + 1; t <= limit && this.table.free(u.id, t, cells); t++) { this.table.reserve(u.id, t, cells); pr.stood = true }
  }
  /**
   * A unit that is not moving holds its body with no end and drops its timed entries. Units whose projections cross
   * the newly held cells re-project at once, so they see the conflict now rather than when they reach it. A unit
   * stalled in traffic records who has the cells of its next tick as its conflict.
   */
  private holdHere(u: Unit): void {
    if (u.projection || this.table.horizon(u.id) > this.time) { this.table.releaseFrom(u.id, this.time + 1); u.projection = null }
    u.conflict = null
    if (u.wait) {
      const m = u.motion, to = u.path[u.cursor], start: [number, number, number] = [u.x, u.y, u.z], L = this.port.layout
      let cells: number[] | null = null
      if (m?.flat) cells = walkSweep(L, start, this.motionPose(m.to, m.elapsed + 1, m.ticks, m.start)).filter(p => m.area!.has(p))
      else if (!m && to !== undefined) {
        const ticks = this.stepTicks(start, to), [tx, ty, tz] = L.voxelCoords(to)
        if (ty * 256 === u.y) { const area = new Set(walkSweep(L, start, [tx * 256 + 128, u.y, tz * 256 + 128])); cells = walkSweep(L, start, this.motionPose(to, 1, ticks, start)).filter(p => area.has(p)) }
        else cells = this.verticalCells(to, ticks, start)
      }
      for (const p of cells ?? []) {
        const o = this.table.owner(p, this.time + 1) || this.occupied.get(p)
        if (o && o !== u.id) { u.conflict = { t: this.time + 1, owner: o }; break }
      }
    }
    const held = this.table.heldBy(u.id)
    if (held.length === u.cells.length && held.every((p, i) => p === u.cells[i])) return
    this.table.hold(u.id, u.cells)
    for (const id of this.table.timedOwners(u.cells, this.time + 1, u.id)) {
      const o = this.units.get(id)
      if (!o) continue
      if (this.projecting(o)) { o.projection = null; this.project(o) } else { this.table.releaseFrom(id, this.time + 1); o.projection = null }
    }
  }
  /** An idle unit with nothing queued, the only kind asked to step aside. */
  private idleUnit(u: Unit): boolean { return u.state === 'idle' && u.goal === null && !u.task && !u.search && !u.motion && !u.engineering && u.path[u.cursor] === undefined && this.time >= u.retry }
  /**
   * Resolves conflicts, best right of way first, at most MAX_REPAIRS per tick. Head-on, one of the two keeps right
   * when it has a lane there. A unit takes the right of way from an idle owner or one with nowhere to be, from an
   * owner already yielding to it, or, once stuck, from a moving owner of lower aged priority or a
   * still one it outranks, provided the owner finds a refuge off its route; a working owner is never displaced, and
   * a unit never takes the right of way of the one it walks behind. Otherwise the unit repairs its own plan with a space-time search. Pending repairs share `cap` operations. Returns
   * the operations used.
   */
  private cooperate(cap: number): number {
    const T = this.time
    // Best right of way first: the order of outranks, from keys computed once per unit.
    // Units dozing since an earlier tick are left alone; one that fell asleep this tick still had its conflict looked at.
    const conflicted = [...this.units.values()].filter(u => u.conflict?.owner && !this.sleepers.dozing(u.id, T) && !u.repair && T >= u.repairAfter && u.state !== 'incapacitated' && (u.motion || u.path[u.cursor] !== undefined))
      .map(u => ({ u, p: this.priority(u), r: this.rotation(u) })).sort((a, b) => b.p - a.p || a.r - b.r || a.u.id - b.u.id).map(k => k.u)
    let started = 0, used = 0
    for (const u of conflicted) {
      if (started >= MAX_REPAIRS || used >= cap) break
      if (u.repair || !u.conflict) continue
      const o = this.units.get(u.conflict.owner)
      if (!o || o === u) continue
      // Lanes, preemption and make-way may change o's plan or hold: a sleeping o wakes to carry it out.
      this.sleepers.wake(o.id)
      // Head-on: whichever of the two has a free lane to its right takes it, and both walk on.
      if (this.headOn(u, o) && (this.laneChange(u) || !o.repair && this.laneChange(o))) continue
      started++
      // A unit behind another walking its way waits in the queue; it never takes the leader's right of way.
      const behind = this.follows(u, o)
      // Repairs that keep it waiting this long have not worked: today's detour, sidestep and traffic block take over.
      if (u.stuck >= STUCK_LIMIT && !behind) { this.cut(u); u.schedule = null; u.wait = 80; this.yield(u); u.stuck = 0; continue }
      const yielding = o.yieldTo === u.id && T < o.yieldUntil, owed = u.yieldTo === o.id && T < u.yieldUntil
      // An owner already on its way out is left to finish it.
      if (yielding && (this.moving(o) || o.repair)) continue
      // An idle owner is always asked to step off the route, and so is one with nowhere to be that stands in the way
      // of a unit with a destination (say, while it walks off someone else's route).
      const idle = !o.projection && this.idleUnit(o), aimless = !this.moving(o) && o.goal === null && !o.task && (u.goal !== null || u.task !== null)
      const takes = idle || aimless || yielding || !owed && !behind && u.stuck >= STUCK_STEP && (this.moving(o) ? this.priority(u) > this.priority(o) : (o.goal !== null || o.task !== null) && this.outranks(u, o))
      // Only an owner that walks or waits on plain path steps can be handed a plan: not one working, falling or engineering.
      if (takes && (o.state === 'idle' || o.state === 'planning' || o.state === 'walking' || o.state === 'blocked') && !o.engineering && !o.actions[o.actionCursor] && !o.repair && T >= o.repairAfter) {
        const r = this.preempt(u, o, Math.max(0, cap - used))
        used += r.used
        if (r.ok) continue
        // o has no way out: u gives way instead if it has one (the unit nearer a refuge yields).
        if ((u.state === 'planning' || u.state === 'walking' || u.state === 'blocked') && !u.engineering && !u.actions[u.actionCursor] && !o.motion && (o.goal !== null || o.task !== null)) {
          const back = this.preempt(o, u, Math.max(0, cap - used))
          used += back.used
          if (back.ok) continue
        }
        // An idle owner with no refuge in reach of one window walks to the nearest pose off u's route instead.
        if (idle || aimless && !o.search) { this.makeWay(o, u); continue }
        // Neither has a way out: an idle unit standing next to either of them makes room.
        const near = this.idleNeighbour(u, o)
        if (near) { this.makeWay(near, u); continue }
      }
      // Settling the right of way re-projects both units, which may clear the conflict: nothing is left to repair then.
      if (!u.repair && u.conflict) this.startRepair(u)
    }
    // Repairs left pending share the rest, starting from a unit that rotates with the tick; one pending for
    // REPAIR_TICKS is dropped, so no unit waits behind a search that starves.
    const pending = [...this.units.values()].filter(u => u.repair)
    for (let n = 0; n < pending.length; n++) {
      const u = pending[(T + n) % pending.length]!, r = u.repair!
      if (used < cap) used += r.step(cap - used)
      if (r.status === 'pending' && T - u.repairFrom!.at >= REPAIR_TICKS) { u.repair = null; u.repairFrom = null; u.repairAfter = T + 8; continue }
      this.settleRepair(u)
    }
    return used
  }
  /** Adopts a found repair, or drops a failed one and waits before the next. */
  private settleRepair(u: Unit): void {
    const r = u.repair!
    if (r.status === 'found') this.applyRepair(u)
    else if (r.status === 'failed') { u.repair = null; u.repairFrom = null; u.repairAfter = this.time + 8 }
  }
  /**
   * u takes the cells o has from the conflict on: o drops its plan, u (if still) waits PREEMPT_DELAY ticks so o can
   * leave first and projects through, and o repairs at once around u's new route. If o finds no way out, everything
   * is put back as it was and u repairs instead.
   */
  private preempt(u: Unit, o: Unit, cap: number): { ok: boolean; used: number } {
    const T = this.time, schedule = u.schedule
    this.table.releaseFrom(o.id, T + 1); this.table.releaseHold(o.id); o.projection = null
    if (!this.moving(u)) {
      this.cut(u)
      const n = Math.max(1, u.cursor), old = u.schedule?.path === u.path ? u.schedule.untils : null, untils = new Array<number>(n)
      for (let i = 0; i < n; i++) untils[i] = old?.[i] ?? -1
      untils[n - 1] = Math.max(untils[n - 1]!, T + PREEMPT_DELAY)
      u.schedule = { path: u.path, untils }
    }
    u.projection = null; this.project(u)
    o.conflict = { t: T + 1, owner: u.id }
    // o looks for a refuge off u's remaining route that it can reach ahead of u and hold until the window's end (the
    // search runs within this call, so the destinations are read live).
    const tail = new Set<number>(), here = this.position(u)
    for (let i = Math.max(0, u.cursor - 1); i < u.path.length; i++) tail.add(u.path[i]!)
    this.startRepair(o, p => p !== here && !tail.has(p) && !this.otherGoal(p, o))
    const r = o.repair
    const used = r ? r.step(Math.min(cap, r.remaining)) : 0
    if (r?.status === 'found') {
      this.applyRepair(o)
      if (o.schedule?.path === o.path) { o.yieldTo = u.id; o.yieldUntil = u.passUntil = T + YIELD_TICKS; return { ok: true, used } }
    }
    // o has no way out (or did not finish): restore its plan, and u plans around it again.
    o.repair = null; o.repairFrom = null; o.repairAfter = T + 8
    u.schedule = schedule; this.table.releaseFrom(u.id, T + 1); u.projection = null
    if (this.projecting(o)) this.project(o); else this.holdHere(o)
    if (this.projecting(u)) this.project(u); else this.holdHere(u)
    return { ok: false, used }
  }
  /** The first idle unit (by id order) whose body is within one block of u's or o's, if any. */
  private idleNeighbour(u: Unit, o: Unit): Unit | undefined {
    for (const c of this.units.values()) if (c !== u && c !== o && !c.projection && this.idleUnit(c)) {
      for (const v of [u, o]) if (Math.abs(c.x - v.x) <= 384 && Math.abs(c.z - v.z) <= 384 && Math.abs(c.y - v.y) <= 256) return c
    }
    return undefined
  }
  /** Units' destinations and how many units have each; rebuilt when any destination changed. Derived, not hashed. */
  private goalCount(): Map<number, number> {
    if (this.goalIndex?.version !== this.goalsVersion) {
      const count = new Map<number, number>()
      for (const u of this.units.values()) if (u.goal !== null) count.set(u.goal, (count.get(u.goal) ?? 0) + 1)
      this.goalIndex = { version: this.goalsVersion, count }
    }
    return this.goalIndex.count
  }
  /** Whether p is the destination of a unit other than o. */
  private otherGoal(p: number, o: Unit): boolean { return (this.goalCount().get(p) ?? 0) > (o.goal === p ? 1 : 0) }
  /** Every other unit's destination: poses a unit must not end a plan or a make-way walk on. */
  private goalsBut(o: Unit): Set<number> {
    const count = this.goalCount(), out = new Set(count.keys())
    if (o.goal !== null && count.get(o.goal) === 1) out.delete(o.goal)
    return out
  }
  /** Poses a unit making way for u must not end on: u's pose and remaining route, and every other unit's destination. */
  private routeAndGoals(u: Unit, o: Unit): Set<number> {
    const out = this.goalsBut(o)
    for (let i = Math.max(0, u.cursor - 1); i < u.path.length; i++) out.add(u.path[i]!)
    out.add(this.position(u))
    return out
  }
  /** Sends an idle unit to the nearest free pose off u's route within MAKE_WAY_RADIUS; it stays idle while it looks. */
  private makeWay(o: Unit, u: Unit): void {
    const L = this.port.layout, route = this.routeAndGoals(u, o), from = this.position(o), [ox, oy, oz] = this.pose(o)
    const near = (p: number) => { const [x, y, z] = L.voxelCoords(p); return Math.abs(x - ox) <= MAKE_WAY_RADIUS && Math.abs(z - oz) <= MAKE_WAY_RADIUS && Math.abs(y - oy) <= 4 }
    o.search = this.nav.request(from, [], undefined, {
      allowed: p => near(p) && this.nav.allowed(p),
      accept: p => p !== from && !route.has(p) && (this.occupied.get(p) ?? o.id) === o.id,
    })
    o.retry = this.time + YIELD_TICKS; this.dirty.add(o.id)
  }
  /** Planar direction (DIRS index) of a flat step between neighbouring poses a→b, or -1. */
  private stepDir(a: number, b: number): number {
    const L = this.port.layout, [ax, ay, az] = L.voxelCoords(a), [bx, by, bz] = L.voxelCoords(b), dx = bx - ax, dz = bz - az
    if (ay !== by || Math.abs(dx) + Math.abs(dz) !== 1) return -1
    return dx ? (dx > 0 ? 0 : 1) : dz > 0 ? 2 : 3
  }
  /**
   * The direction a unit travels: the dominant axis toward the node it walks to next, or toward its destination while
   * it has no path yet; -1 with neither.
   */
  private heading(u: Unit): number {
    const to = u.motion ? u.motion.to : u.path[u.cursor] ?? u.task?.p ?? u.goal ?? undefined
    if (to === undefined) return -1
    const [tx, , tz] = this.port.layout.voxelCoords(to), dx = tx * 256 + 128 - u.x, dz = tz * 256 + 128 - u.z
    if (!dx && !dz) return -1
    return Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 0 : 1) : dz > 0 ? 2 : 3
  }
  /** Whether o is on its way: walking, or waiting to walk on along a path it has (not blocked, not waiting on a search). */
  private onItsWay(o: Unit): boolean { return o.state !== 'blocked' && !o.search && (o.motion !== null || o.path[o.cursor] !== undefined) }
  /**
   * Whether u walks behind o: o is ahead of u and on its way in the same direction. A still or blocked unit that keeps
   * its goal shields no one: waiting behind it would be forever.
   */
  private follows(u: Unit, o: Unit): boolean {
    const d = this.heading(u)
    if (d < 0 || this.heading(o) !== d || !this.onItsWay(o)) return false
    const [dx, dz] = DIRS[d]!
    return (o.x - u.x) * dx + (o.z - u.z) * dz > 0
  }
  /** Whether o comes straight at u: it travels the opposite way, ahead of u. */
  private headOn(u: Unit, o: Unit): boolean {
    const d = this.heading(u)
    if (d < 0 || this.heading(o) !== (d ^ 1)) return false
    const [dx, dz] = DIRS[d]!
    return (o.x - u.x) * dx + (o.z - u.z) * dz > 0
  }
  /** The same-height pose next to p in planar direction d, or -1 (a wall, a drop or a step). */
  private level(p: number, d: number): number {
    const q = this.nav.neighbor(p, d)
    return q >= 0 && this.port.layout.voxelCoords(q)[1] === this.port.layout.voxelCoords(p)[1] ? q : -1
  }
  /**
   * Whether pose p is the oncoming lane for a unit heading d: the left lane of a passage exactly two poses wide that
   * runs on, two wide, for more than LANE_MIN poses along d through p (a pocket beside a one-wide corridor is no lane).
   */
  private oncomingLane(p: number, d: number): boolean {
    const r = RIGHT[d]!, wide = (a: number) => { const s = this.level(a, r); return s >= 0 && this.level(a, r ^ 1) < 0 && this.level(s, r) < 0 }
    if (!wide(p)) return false
    let n = 1
    for (const e of [d, d ^ 1]) for (let a = this.level(p, e); n <= LANE_MIN && a >= 0 && wide(a); a = this.level(a, e)) n++
    return n > LANE_MIN
  }
  /** Whether any of path[from..to) lies in a two-wide passage along its step (either lane). */
  private inPassage(path: readonly number[], from: number, to: number): boolean {
    for (let i = Math.max(0, from); i < Math.min(to, path.length - 1); i++) {
      const d = this.stepDir(path[i]!, path[i + 1]!)
      if (d >= 0 && (this.oncomingLane(path[i]!, d) || this.oncomingLane(path[i]!, d ^ 1))) return true
    }
    return false
  }
  /**
   * The lane right of the straight flat run of path nodes from index b in direction d: for each node, the pose to its
   * right in the same nav tile, while that pose is safe for u and consecutive, never beside the path's last node. With
   * `bodies`, also only while no still body holds it and no unit on another way (oncoming, crossing) stands there.
   */
  private laneRight(u: Unit, b: number, d: number, bodies: boolean): number[] {
    const path = u.path, L = this.port.layout, r = RIGHT[d]!, lane: number[] = []
    const walksWith = (id: number | undefined) => { const o = id === undefined || id === u.id ? undefined : this.units.get(id); return !o || this.heading(o) === d }
    for (let i = b; i < path.length - 1; i++) {
      if (i > b && this.stepDir(path[i - 1]!, path[i]!) !== d) break
      const p = path[i]!, s = this.level(p, r)
      if (s < 0 || this.nav.tileOfPose(s) !== this.nav.tileOfPose(p) || !this.poseOk(u, L.voxelCoords(s)) || lane.length && this.nav.neighbor(lane.at(-1)!, d) !== s) break
      if (bodies && (this.poseHeld(s, u) || !walksWith(this.occupied.get(s)))) break
      // A lane never runs through a body that is not on its way: the path passes it in the other lane.
      const still = this.occupied.get(s), o = still === undefined || still === u.id ? undefined : this.units.get(still)
      if (o && !this.onItsWay(o)) break
      lane.push(s)
    }
    return lane
  }
  /**
   * Moves the path's straight run from node b one lane to the right (see laneRight), then back onto the old path where
   * the lane ends; a path that turns right there goes on from the lane. Route segments keep indexing the same nodes,
   * and a repair plan's schedule, which only covers nodes up to b, stays.
   */
  private shiftRight(u: Unit, b: number, lane: readonly number[]): void {
    const path = u.path, k = b + lane.length - 1, turns = path[k + 1] === lane.at(-1), s = u.schedule
    u.path = [...path.slice(0, b + 1), ...lane, ...path.slice(turns ? k + 2 : k)]
    if (u.route) u.route.segs = u.route.segs.map(g => ({ ...g, end: g.end <= b ? g.end : g.end < k ? g.end + 1 : turns ? g.end === k ? k + 1 : g.end : g.end + 2 }))
    u.schedule = s && s.path === path && s.untils.length <= b + 1 ? { path: u.path, untils: s.untils } : null
    this.dirty.add(u.id)
  }
  /**
   * Keeps right past an oncoming unit: from the node the unit stands on (stopping a flat motion there), its path takes
   * the lane to its right, if that lane runs more than LANE_MIN nodes. True when the path changed.
   */
  private laneChange(u: Unit): boolean {
    const m = u.motion, path = u.path
    if (m && !m.flat || u.engineering || u.actions[u.actionCursor] || u.repair) return false
    const here = this.position(u)
    let b = -1
    for (let i = m ? m.cursor - 1 : u.cursor - 1; i >= Math.max(0, u.cursor - 1); i--) if (path[i] === here) { b = i; break }
    if (b < 0 || b + 1 >= path.length - 1) return false
    const d = this.stepDir(path[b]!, path[b + 1]!)
    if (d < 0) return false
    const lane = this.laneRight(u, b, d, true)
    if (lane.length <= LANE_MIN) return false
    if (m) this.cut(u)
    this.shiftRight(u, b, lane)
    u.cursor = b + 1; u.conflict = null; u.wait = 0; u.reason = undefined; u.projection = null
    if (this.projecting(u)) this.project(u); else this.holdHere(u)
    return true
  }
  /**
   * Keeps right in passages exactly two poses wide, before anyone meets there: every straight run of the path still to
   * walk that lies in the oncoming lane (see oncomingLane) moves to the right lane, if that lane runs more than LANE_MIN
   * nodes (a pocket beside the path is no lane; it stays free as a refuge). Lanes are geometry, except that one never
   * runs through a body that is not on its way; `laned` remembers how far the current path was looked at.
   */
  private keepRight(u: Unit): void {
    const done = u.laned?.path === u.path ? u.laned.len - 1 : 0
    let b = Math.max(u.cursor - 1, this.scheduled(u) - 1, done)
    if (!u.engineering && !u.actions[u.actionCursor]) while (b < u.path.length - 2) {
      const d = this.stepDir(u.path[b]!, u.path[b + 1]!)
      if (d >= 0 && this.oncomingLane(u.path[b]!, d)) {
        const lane = this.laneRight(u, b, d, false)
        if (lane.length > LANE_MIN) { this.shiftRight(u, b, lane); b += lane.length + 1; continue }
      }
      b++
    }
    u.laned = { path: u.path, len: u.path.length }
  }
  /** Stops a flat motion where the unit is, resuming the path from the node it stands on when it is on the route. */
  private cut(u: Unit): void {
    const m = u.motion
    if (!m?.flat) return
    const here = this.position(u)
    for (let i = m.cursor - 1; i >= Math.max(0, u.cursor - 1); i--) if (u.path[i] === here) { u.cursor = i + 1; break }
    u.motion = null; this.reserve(u, this.body(u.x, u.y, u.z)); u.state = 'planning'; this.dirty.add(u.id)
  }
  /** Port for a unit's repair: its live pose policy, and its real start pose for the first step. */
  private spaceTimePort(u: Unit, start: number, startPose: [number, number, number]): SpaceTimePort {
    const L = this.port.layout
    const at = (p: number): [number, number, number] => { if (p === start) return startPose; const [x, y, z] = L.voxelCoords(p); return [x * 256 + 128, y * 256, z * 256 + 128] }
    return {
      neighbor: (p, d) => this.nav.neighbor(p, d), allowed: p => this.poseOk(u, L.voxelCoords(p)), coords: p => L.voxelCoords(p),
      cellsOf: p => this.body(...at(p)),
      stepCells: (a, b) => { const s = at(a), e = at(b); return e[1] === s[1] ? walkSweep(L, s, e) : this.verticalCells(b, this.stepTicks(s, b), s) },
      ticksOf: (a, b) => this.stepTicks(at(a), b),
      oncoming: (p, d) => this.oncomingLane(p, d),
    }
  }
  /**
   * Starts a repair from where the unit can next act: the end of a vertical action (or of a flat motion that ends
   * before the conflict), otherwise from its current pose, stopping a flat motion where it is.
   */
  private startRepair(u: Unit, refuge?: (p: number) => boolean): void {
    this.sleepers.wake(u.id)
    const m = u.motion, T = this.time, L = this.port.layout
    let start: number, startTick: number, cursor: number, pose: [number, number, number]
    if (m && u.wait === 0 && (!m.flat || u.conflict!.t > T + m.ticks - m.elapsed)) {
      start = m.to; startTick = T + m.ticks - m.elapsed; cursor = m.cursor
      const [x, y, z] = L.voxelCoords(m.to); pose = [x * 256 + 128, y * 256, z * 256 + 128]
    } else {
      if (m && !m.flat) return
      this.cut(u)
      start = this.position(u); startTick = T + 1; cursor = u.cursor; pose = [u.x, u.y, u.z]
    }
    const ahead = u.path.slice(cursor, cursor + REPAIR_SPAN), targets = refuge ? [] : ahead
    if (!targets.length && !refuge) { u.repairAfter = T + 8; return }
    // A unit with nothing to do stays where its plan ends, so that must not be someone else's destination.
    const goals = u.goal === null && !u.task ? this.goalsBut(u) : null
    u.repair = new SpaceTimeSearch(this.spaceTimePort(u, start, pose), this.table, u.id, start, startTick, targets, undefined, undefined, refuge, goals ? p => goals.has(p) : undefined, ahead.at(-1))
    u.repairFrom = { path: u.path, cursor, start, startTick, at: T }
  }
  /** Adopts a found plan if the unit is still where and when it starts: its poses, then the rest of the route it rejoins. */
  private applyRepair(u: Unit): void {
    const from = u.repairFrom!, plan = u.repair!.plan!, m = u.motion
    u.repair = null; u.repairFrom = null
    const here = m ? m.to === from.start && this.time + m.ticks - m.elapsed === from.startTick : this.position(u) === from.start
    if (!here || u.path !== from.path || plan.steps[0]!.until <= this.time) { u.repairAfter = this.time + 1; return }
    // A plan ending back on the node the unit set out from keeps the rest of its route too.
    const rejoin = plan.rejoin >= 0 ? from.cursor + plan.rejoin : plan.steps.at(-1)!.pose === from.path[from.cursor - 1] ? from.cursor - 1 : -1
    u.path = [...plan.steps.map(s => s.pose), ...rejoin >= 0 ? from.path.slice(rejoin + 1) : []]
    // A route's refined segments index the path: the rejoined tail moves by the plan's length, the replaced head is gone.
    if (u.route) { const shift = plan.steps.length - (rejoin + 1); u.route.segs = rejoin < 0 ? [] : u.route.segs.filter(g => g.end > rejoin).map(g => ({ ...g, end: g.end + shift })) }
    u.cursor = 1; u.schedule = { path: u.path, untils: plan.steps.map(s => s.until) }; u.conflict = null; u.wait = 0; u.repairAfter = this.time + REPAIR_COOLDOWN
    if (m) m.cursor = 1
    if (this.projecting(u)) { u.projection = null; this.project(u) }
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
      stats: { units: this.units.size, sleeping: this.sleepers.size, deferred: this.deferred.size, orders: this.orders.filter(o => !o.cancelled && o.done < o.total).length, tasks: this.tasks.length, searches: this.nav.pending + [...this.units.values()].filter(u => u.engineering !== null).length, visited: this.nav.visited + this.engineeringVisited + this.refineWork, mutations: this.mutations, navBytes: this.nav.bytes, cacheTiles: this.nav.cacheTiles, regionBytes: this.nav.regions.bytes, regions: this.nav.regions.size } }
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
      mix(u.available ? 1 : 0); numbers(u.escape.map(o => o.id)); mix(u.exposed); mix(u.unsafeHere ? 1 : 0); mix(u.wadingOut ? 1 : 0); mix(u.stale); mix(u.progressAt); reason(u.reason); mix(u.validatedWorld); numbers(u.validatedPose)
      mix(u.tools.size); for (const t of u.tools) { mix(t.length); for (const c of t) mix(c.charCodeAt(0)) }
      mix(u.stock.size)
      for (const [b, n] of u.stock) { mix(b); mix(n) }
      numbers(u.path); numbers(u.workPoses); numbers(u.cells); numbers(u.alternative)
      mix(u.task ? 1 : 0); if (u.task) task(u.task)
      mix(u.motion ? 1 : 0)
      if (u.motion) { mix(u.motion.from); mix(u.motion.to); mix(u.motion.cursor); mix(u.motion.flat ? 1 : 0); mix(u.motion.elapsed); mix(u.motion.ticks); numbers(u.motion.start); numbers(u.motion.cells); numbers([...(u.motion.area ?? [])]) }
      const pr = u.projection
      mix(pr ? 1 : 0); if (pr) { mix(pr.cursor); numbers(pr.pose); mix(pr.t); mix(pr.end); mix(pr.first); mix(pr.stood ? 1 : 0); mix(pr.len); mix(pr.endAt) }
      mix(u.conflict ? 1 : 0); if (u.conflict) { mix(u.conflict.t); mix(u.conflict.owner) }
      mix(u.stuck); mix(u.best); mix(u.bestTarget); mix(u.repairAfter); mix(u.yieldTo); mix(u.yieldUntil); mix(u.passUntil); numbers(u.schedule?.path === u.path ? u.schedule.untils : []); mix(u.laned?.path === u.path ? u.laned.len : -1)
      mix(u.repair ? 1 : 0); u.repair?.mixState(mix)
      if (u.repairFrom) { mix(u.repairFrom.cursor); mix(u.repairFrom.start); mix(u.repairFrom.startTick); mix(u.repairFrom.at); mix(u.repairFrom.path === u.path ? 1 : 0) }
      mix(u.route ? 1 : 0)
      if (u.route) {
        const r = u.route, s = r.search
        mix(s instanceof GroupField ? this.groups.get(s)!.id : -1); mix(STATUSES.indexOf(s.status))
        if (s instanceof RouteSearch) { mix(s.cost); numbers(s.keys); mix(s.goal) }
        numbers(r.goals); numbers(r.exits); numbers(r.recovered); mix(r.hop); mix(r.last); numbers(r.exclude); mix(r.finished ? 1 : 0); mix(r.replan ? 1 : 0)
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
    this.table.mixState(mix)
    this.sleepers.mixState(mix)
    mix(this.deferred.size); for (const [id, t] of [...this.deferred].sort((a, b) => a[0] - b[0])) { mix(id); mix(t) }
    this.nav.mixState(mix)
  }
}
