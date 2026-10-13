import type { Vec3 } from '../commands.ts'
import type { WorkBlockReason, WorkerState } from './types.ts'

/** A unit as a save keeps it (plan deviation 6): where it stands, what it carries and where it is going. */
export interface UnitSnapshot {
  id: number; x: number; y: number; z: number; facing: number; state: WorkerState; vy: number
  tools: string[]; stock: [number, number][]; goal: number | null; available: boolean; allowDig: boolean; buildBlock: number
}

export interface OrderSnapshot {
  id: number; kind: 'dig' | 'build'; min: Vec3; max: Vec3; voxel: number; total: number; done: number; pending: number; cancelled: boolean; reason?: WorkBlockReason
  cursor: number; ids: number[] | null; priority: number
  parked: number[]
  ringPending: number[] | null; rings: number; floor: number; ring: number; progress: number; stalled: boolean; idleSince: number; noCrewSince: number
}

/** A frontier task without its claim and failure history: the unit that held it plans again. */
export interface TaskSnapshot { order: number; i: number; expected: number; added: number; reason?: WorkBlockReason }

export interface WorkersSnapshot {
  nextUnit: number; nextOrder: number; time: number; assignmentCursor: number
  units: UnitSnapshot[]; orders: OrderSnapshot[]
  /** The work frontier in its order. Tasks of internal orders (negative ids) are not kept. */
  tasks: TaskSnapshot[]
  /** Drop piles: voxel index → [block, count] stacks. */
  loose: [number, [number, number][]][]
}
