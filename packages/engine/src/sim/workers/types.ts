import type { Vec3 } from '../commands.ts'

export interface WorkMaterial { digTicks?: number; buildTicks?: number; drop?: string; tool?: string }
export interface WorkerOptions {
  maxUnits?: number
  /** Total navigation operations per physics tick, shared fairly between searches. */
  searchCap?: number
  maxSearchNodes?: number
  maxOrders?: number
  assignmentCap?: number
  commitCap?: number
  inventoryCapacity?: number
  materials?: Record<string, WorkMaterial>
}
export type WorkerState = 'idle' | 'planning' | 'walking' | 'working' | 'blocked' | 'falling' | 'incapacitated'
export type WorkBlockReason = 'no-access' | 'missing-material' | 'missing-tool' | 'unsafe' | 'traffic' | 'search-limited' | 'target-changed'
export interface WorkerView {
  available: boolean
  id: number; x256: number; y256: number; z256: number; facing: number; state: WorkerState
  order: number; progress: number; duration: number; reason?: WorkBlockReason
  stock: readonly { block: number; count: number }[]
}
export interface WorkOrderView {
  id: number; kind: 'dig' | 'build'; min: Vec3; max: Vec3; voxel: number
  total: number; done: number; pending: number; cancelled: boolean; reason?: WorkBlockReason
}
export interface WorkerStats { units: number; orders: number; tasks: number; searches: number; visited: number; mutations: number; navBytes: number; cacheTiles: number }
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
