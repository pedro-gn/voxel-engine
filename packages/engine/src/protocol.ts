import type { BlockDef } from './blocks/registry.ts'
import type { ChunkMeshData } from './mesh/mesher.ts'
import type { MeshTables } from './mesh/tables.ts'
import type { Ack, Command } from './sim/commands.ts'
import type { SimEvent } from './sim/simulation.ts'
import type { WorldBuffers } from './world/buffers.ts'

export interface SimInitOptions {
  workCap?: number
  randomTicksPerChunk?: number
  maxPages?: number
  tickHz?: number
}

export type ToSim =
  /** `terrain`: the document handed to the generator's configure() before generation. */
  | { type: 'init'; buffers: WorldBuffers; blocks: BlockDef[]; seed: number; options: SimInitOptions; terrain?: unknown }
  | { type: 'submit'; clientId: number; seq: number; cmd: Command }
  | { type: 'start' }
  | { type: 'stop' }

export type FromSim =
  | { type: 'page'; index: number; page: SharedArrayBuffer }
  /** `genMs`: wall time of the initial generation, light pass included. `columns`: chunk columns generated. */
  | { type: 'ready'; chunks: number[]; slotsUsed: number; genMs: number; columns: number }
  | { type: 'tick'; tick: number; dirtyChunks: number[]; events: SimEvent[]; acks: Ack[]; slotsUsed: number; tickMs: number }
  | { type: 'log'; message: string }
  /** `slots` is set when the world ran out of slot pages: the slot count in use at that point. */
  | { type: 'fatal'; message: string; slots?: number }

/** World-space ghost voxel: [x, y, z, voxel]. */
export type Override = readonly [number, number, number, number]

export type ToMesh =
  | { type: 'init'; buffers: WorldBuffers; pages: SharedArrayBuffer[]; tables: MeshTables }
  | { type: 'page'; index: number; page: SharedArrayBuffer }
  | { type: 'job'; id: number; chunk: number; overrides?: Override[] }

export type FromMesh =
  | { type: 'result'; id: number; chunk: number; version: number; data: ChunkMeshData }
  | { type: 'retry'; id: number; chunk: number }
  | { type: 'error'; id: number; chunk: number; message: string }
