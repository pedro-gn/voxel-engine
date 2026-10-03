import { CHUNK_VOLUME } from '../world/layout.ts'

/** diffMask bits: something differs, then the six one-voxel border slabs of the chunk. */
export const CHANGED = 1
export const NEG_X = 2
export const POS_X = 4
export const NEG_Y = 8
export const POS_Y = 16
export const NEG_Z = 32
export const POS_Z = 64
const ALL = 127

/**
 * Compares two chunk arrays (voxels or light, index lx + lz * 32 + ly * 1024): 0 if equal, else
 * CHANGED plus the bit of every border slab holding a difference.
 */
export function diffMask(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0
  for (let i = 0; i < CHUNK_VOLUME; i++) {
    if (a[i] === b[i]) continue
    const lx = i & 31, lz = (i >> 5) & 31, ly = i >> 10
    m |= CHANGED
    if (lx === 0) m |= NEG_X
    else if (lx === 31) m |= POS_X
    if (ly === 0) m |= NEG_Y
    else if (ly === 31) m |= POS_Y
    if (lz === 0) m |= NEG_Z
    else if (lz === 31) m |= POS_Z
    if (m === ALL) return m
  }
  return m
}

/**
 * A neighbour's mesh reads a one-voxel apron of this chunk. Visits every neighbour offset whose
 * apron can hold a change: each non-zero axis of the offset must have its border slab flagged. A
 * changed edge voxel lies on both slabs, so this is a superset of the neighbours that need a remesh.
 */
export function forNeighbours(mask: number, visit: (dx: number, dy: number, dz: number) => void): void {
  if (!(mask & CHANGED)) return
  for (let dy = -1; dy <= 1; dy++) {
    if ((dy === -1 && !(mask & NEG_Y)) || (dy === 1 && !(mask & POS_Y))) continue
    for (let dz = -1; dz <= 1; dz++) {
      if ((dz === -1 && !(mask & NEG_Z)) || (dz === 1 && !(mask & POS_Z))) continue
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx === -1 && !(mask & NEG_X)) || (dx === 1 && !(mask & POS_X))) continue
        if (dx !== 0 || dy !== 0 || dz !== 0) visit(dx, dy, dz)
      }
    }
  }
}
