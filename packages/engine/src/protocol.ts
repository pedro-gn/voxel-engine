import type { BlockDef } from './blocks/registry.ts'
import type { ChunkMeshData } from './mesh/mesher.ts'
import type { MeshTables } from './mesh/tables.ts'
import type { Ack, Command } from './sim/commands.ts'
import type { FallingBodyState, Landing } from './sim/gravity.ts'
import type { SimEvent } from './sim/simulation.ts'
import type { WorldBuffers } from './world/buffers.ts'
import type { WorldSize } from './world/layout.ts'

export interface SimInitOptions {
  workCap?: number
  randomTicksPerChunk?: number
  maxPages?: number
  tickHz?: number
  /** After every water step, check Σ depth + sea against the running total and that no depth is negative (slow; for debugging). On failure: log and rebuild from the voxels. */
  debugFluids?: boolean
  /** Awake water tiles (16 × 16 columns) stepped per tick, in tile order, round robin (integer ≥ 1). Default 1024. */
  waterTileCap?: number
  /** Start with physics (gravity, water, region jobs) paused. */
  paused?: boolean
}

/** World blocks [x0, x1) × [z0, z1), full height. */
export interface TerrainRect { x0: number; z0: number; x1: number; z1: number }

export type ToSim =
  /**
   * `terrain`: the document handed to the generator's configure() before generation.
   * `genPorts`: one port per generation worker; when present, columns are generated there in parallel.
   */
  | { type: 'init'; buffers: WorldBuffers; blocks: BlockDef[]; seed: number; options: SimInitOptions; terrain?: unknown; genPorts?: MessagePort[] }
  | { type: 'submit'; clientId: number; seq: number; cmd: Command }
  | { type: 'start' }
  | { type: 'stop' }
  /** Replaces the generator's document (configure) everywhere; answered by 'terrain'. */
  | { type: 'setTerrain'; id: number; doc: unknown }
  /** Applies an incremental change to the generator's document everywhere (patch); answered by 'terrain'. */
  | { type: 'patchTerrain'; id: number; patch: unknown }
  /** Regenerates the chunk columns overlapping `rect` between two ticks; answered by 'regenerated'. */
  | { type: 'regenerate'; id: number; rect: TerrainRect }
  /** Stops or resumes physics (gravity, water, region jobs). Rules, random ticks, light and the water mirror keep running. */
  | { type: 'setPaused'; paused: boolean }
  /** Main thread: generation worker `index` died. */
  | { type: 'genLost'; index: number }

export type FromSim =
  | { type: 'page'; index: number; page: SharedArrayBuffer }
  /** `genMs`: wall time of the initial generation, light pass included. `columns`: chunk columns generated. */
  | { type: 'ready'; chunks: number[]; slotsUsed: number; genMs: number; columns: number }
  | { type: 'tick'; tick: number; dirtyChunks: number[]; events: SimEvent[]; acks: Ack[]; falling: FallingBodyState[]; landed: Landing[]; physics: { waterTiles: number; waterColumns: number; jobs: number; busy: boolean }; slotsUsed: number; tickMs: number }
  | { type: 'log'; message: string }
  | { type: 'terrain'; id: number; ok: true }
  | { type: 'terrain'; id: number; ok: false; message: string }
  | { type: 'regenerated'; id: number; ok: true; dirtyChunks: number[]; ms: number; slotsUsed: number }
  | { type: 'regenerated'; id: number; ok: false; message: string }
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

/** Sim worker → generation worker (over a MessagePort). Jobs answer with the configuration in force. */
export type ToGen =
  | { type: 'configure'; epoch: number; doc: unknown; size: WorldSize; seed: number; blocks: BlockDef[] }
  /** An incremental change to the configuration; starts a new epoch. */
  | { type: 'patch'; epoch: number; patch: unknown }
  | { type: 'job'; id: number; cx: number; cz: number }

/** Generation worker → sim worker. `epoch` is the configuration the column was generated with. */
export type FromGen =
  | { type: 'column'; id: number; epoch: number; cx: number; cz: number; data: Uint16Array }
  | { type: 'error'; id: number; epoch: number; message: string }
  /** The worker refused a patch: its configuration no longer matches the sim's. */
  | { type: 'fatal'; epoch: number; message: string }

/** Main thread → generation worker, once: the port to the sim worker. */
export interface GenConnect { type: 'connect'; port: MessagePort }
