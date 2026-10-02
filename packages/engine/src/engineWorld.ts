import type { GhostEdits } from './interact/ghostEdits.ts'
import { PRIORITY } from './render/meshQueue.ts'
import type { Ack } from './sim/commands.ts'
import type { WorldSize } from './world/layout.ts'
import { voxelId } from './world/voxel.ts'

/** Browser-free pieces of createEngine's world wiring, kept here so Node tests can reach them. */

export type VoxelGetter = (x: number, y: number, z: number) => number

/** Live voxel read: a pending ghost edit wins over shared memory. */
export function ghostAwareGet(ghosts: GhostEdits, get: VoxelGetter): VoxelGetter {
  return (x, y, z) => ghosts.get(x, y, z) ?? get(x, y, z)
}

/**
 * Remesh marks for one sim tick. Every ack of ours, accepted or rejected, drops its ghosts and
 * remeshes each chunk they touched (diagonal AO neighbours included); then the tick's dirty
 * chunks are marked in the same pass, so the authoritative mesh replaces the ghost one without a gap.
 */
export function markTick(
  tick: { readonly acks: readonly Ack[]; readonly dirtyChunks: readonly number[] },
  clientId: number,
  ghosts: GhostEdits,
  mark: (ci: number, priority: number) => void,
): void {
  for (const a of tick.acks) if (a.clientId === clientId) for (const ci of ghosts.resolve(a.seq)) mark(ci, PRIORITY.GHOST)
  for (const ci of tick.dirtyChunks) mark(ci, PRIORITY.DIRTY)
}

const cell = (v: number, n: number) => (Number.isFinite(v) ? Math.min(n - 1, Math.max(0, Math.floor(v))) : 0)

/** One above the highest solid voxel in the column under (x, z), clamped into the world. Always finite. */
export function columnTop(get: VoxelGetter, solid: Uint8Array, size: WorldSize, x: number, z: number): number {
  const xi = cell(x, size[0]), zi = cell(z, size[2])
  for (let y = size[1] - 1; y >= 0; y--) if (solid[voxelId(get(xi, y, zi))]) return y + 1
  return 0
}
