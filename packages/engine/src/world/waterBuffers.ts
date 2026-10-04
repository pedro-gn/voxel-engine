import type { WorldSize } from './layout.ts'

/** Water heights are fixed point: one block is SUB sub-units. */
export const SUB = 256
/** A column floor meaning "nothing simulated here": every liquid voxel in the column is static. */
export const NO_FLOOR = 0x7fff

/**
 * Heightfield water state, written only by the sim worker and read by the main thread and the mesh workers
 * (plan design notes: Publishing). Columns are indexed x + z × sizeX.
 * - `floor`: Int16 per column, the y of the top face the column's water rests on. Mesh workers draw water voxels below it.
 * - `surface`: Int32 × 2 parities × columns. A wet column stores its surface S (1/SUB block); a dry one stores ~S, its ground.
 * - `flux`: Int16 × 2 parities × columns × 2, the water moved through each column's +x and +z edges last step (1/SUB block).
 * - `stamp`: Int32 × 2, per parity the sequence number of the publish last completed there; −1 while one is being written.
 */
export interface WaterBuffers {
  floor: SharedArrayBuffer
  surface: SharedArrayBuffer
  flux: SharedArrayBuffer
  stamp: SharedArrayBuffer
}

export function createWaterBuffers(size: WorldSize): WaterBuffers {
  const n = size[0] * size[2]
  const floor = new SharedArrayBuffer(n * 2)
  new Int16Array(floor).fill(NO_FLOOR)
  const surface = new SharedArrayBuffer(n * 2 * 4)
  new Int32Array(surface).fill(-1)
  const stamp = new SharedArrayBuffer(2 * 4)
  new Int32Array(stamp).fill(-1)
  return { floor, surface, flux: new SharedArrayBuffer(n * 2 * 2 * 2), stamp }
}
