import type { Vec3 } from '../commands.ts'

export interface WorkMaterial { digTicks?: number; buildTicks?: number; drop?: string; tool?: string }
export interface WorkerOptions {
  maxUnits?: number
  /** Total navigation operations per physics tick, shared fairly between searches. */
  searchCap?: number
  maxSearchNodes?: number
  /**
   * Most navigation operations the background region prebuild and landmark recompute may spend per tick once the world is
   * warm (every tile built and the landmark tables settled once; default 1024). Warming a cold world uses the whole leftover.
   */
  prebuildCap?: number
  /** Units queued behind another unit sleep until it moves (default true). False keeps every unit awake (A/B, tests). */
  sleep?: boolean
  /** Units that are not moving, working or idle that take decisions per tick (default 256); the rest wait, oldest first. */
  decisionCap?: number
  maxOrders?: number
  /** Fixed number of idle units assigned per tick; when unset, max(16, ceil(idle / assignmentShare)). */
  assignmentCap?: number
  /** Idle units per assignment per tick when assignmentCap is unset (default 8). */
  assignmentShare?: number
  commitCap?: number
  inventoryCapacity?: number
  /**
   * Work materials by block name. A solid block may be dug and built; a non-solid one (not liquid) may only be built (a bed:
   * `buildTicks` alone), and it never serves as a route's floor (`unitMove.buildBlock`).
   */
  materials?: Record<string, WorkMaterial>
  /**
   * Cells above its feet a unit builds at (1..16, default 1: the head's height). Above its head it reaches up its own column,
   * which must be clear of solid blocks up to the target. Digging keeps a reach of 1.
   */
  buildReach?: number
}
export type WorkerState = 'idle' | 'planning' | 'walking' | 'working' | 'blocked' | 'falling' | 'incapacitated'
export type WorkBlockReason = 'no-access' | 'missing-material' | 'missing-tool' | 'unsafe' | 'traffic' | 'search-limited' | 'target-changed'
/** What a game system asked one controlled unit to do (one at a time; a new intent replaces the old). */
export type Intent = { kind: 'goTo'; pos: Vec3 } | { kind: 'dig'; pos: Vec3 } | { kind: 'build'; pos: Vec3; voxel: number }
/** What happened to a controlled unit this tick (game systems read these after the units step). */
export type UnitEvent =
  | { unit: number; type: 'arrived' }
  | { unit: number; type: 'dug'; pos: Vec3; voxel: number }
  | { unit: number; type: 'built'; pos: Vec3; voxel: number }
  | { unit: number; type: 'failed'; reason: WorkBlockReason }
  | { unit: number; type: 'fell'; height: number }
  | { unit: number; type: 'died'; cause: 'void' }
export interface WorkerView {
  available: boolean
  id: number; x256: number; y256: number; z256: number; facing: number; state: WorkerState
  order: number; progress: number; duration: number; reason?: WorkBlockReason
  stock: readonly { block: number; count: number }[]
  /** Set for a unit owned by a game system, with its current intent (null when it has none). */
  controlled?: boolean
  intent?: Intent | null
}
export interface WorkOrderView {
  id: number; kind: 'dig' | 'build'; min: Vec3; max: Vec3; voxel: number
  total: number; done: number; pending: number; cancelled: boolean; reason?: WorkBlockReason
  /** Priority plus aging while the order waits without progress; it orders expansion, parking and assignment. */
  effectivePriority: number
}
export interface WorkerStats { units: number; sleeping: number; deferred: number; orders: number; tasks: number; searches: number; visited: number; mutations: number; navBytes: number; cacheTiles: number; regionBytes: number; regions: number }
export interface WorkerBarrier {
  /** The unit that made the edit, and the edited voxel. */
  unit: number; pos: Vec3
  /** Every chunk whose mesh the edit changes (the 3 × 3 × 3 box around `pos`), sorted, with its version after the edit. */
  chunks: { chunk: number; version: number }[]
}
export interface WorkerTick {
  /** The sim tick this publication closes. */
  tick: number
  /** One per dig or build committed this tick. */
  barriers: WorkerBarrier[]
  /** Persistent pile deltas; count 0 removes a stack. */
  drops: { pos: Vec3; block: number; count: number }[]
  /** Fixed-stride poses [id,x256,y256,z256,facing,stateCode,order,progress,duration]. */
  poses: Int32Array
  orders: WorkOrderView[]
  stats: WorkerStats
  /** Detail deltas for units whose state/inventory changed. Poses contain every live id. */
  details: WorkerView[]
}
export const WORKER_STATES: readonly WorkerState[] = ['idle', 'planning', 'walking', 'working', 'blocked', 'falling', 'incapacitated']
export type WorkerCommand =
  | { type: 'unitSpawn'; pos: Vec3; tools?: string[]; stock?: { block: number; count: number }[] }
  | { type: 'unitDespawn'; ids: number[] }
  | { type: 'unitMove'; ids: number[]; pos: Vec3; allowDig?: boolean; buildBlock?: number }
  | { type: 'unitCancel'; ids: number[] }
  | { type: 'unitStock'; ids: number[]; block: number; count: number }
  | { type: 'unitCollect'; ids: number[] }
  | { type: 'workDig'; min: Vec3; max: Vec3; ids?: number[]; priority?: number }
  | { type: 'workBuild'; min: Vec3; max: Vec3; voxel: number; ids?: number[]; priority?: number }
  | { type: 'workCancel'; order: number }

export const WORKER_COMMANDS = new Set(['unitSpawn', 'unitDespawn', 'unitMove', 'unitCancel', 'unitStock', 'unitCollect', 'workDig', 'workBuild', 'workCancel'])
