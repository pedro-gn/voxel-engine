import type { WorldSize } from '../world/layout.ts'
import { voxelId } from '../world/voxel.ts'
import type { Vec3Like } from './raycast.ts'

/** An axis-aligned box in world blocks. Voxel (x, y, z) occupies [x, x+1) × [y, y+1) × [z, z+1). */
export interface Box {
  readonly minX: number; readonly minY: number; readonly minZ: number
  readonly maxX: number; readonly maxY: number; readonly maxZ: number
}
/** What collision reads. `solid`, `liquid` and `source` are the registry's per-id tables. */
export interface CollisionWorld {
  readonly size: WorldSize
  get(x: number, y: number, z: number): number
  readonly solid: Uint8Array
  readonly liquid: Uint8Array
  readonly source: Uint8Array
}
/** Faces closer than this are touching, not overlapping (absorbs float residue at contact). */
export const CONTACT_EPS = 1e-7
/** A box is grounded when solid lies within this distance below it. */
export const GROUND_EPS = 1e-3

export interface SweepResult {
  /** The allowed displacement. */
  dx: number; dy: number; dz: number
  /** That axis moved less than requested. */
  blockedX: boolean; blockedY: boolean; blockedZ: boolean
}
export interface MoveOptions { /** Highest ledge climbed without a jump; default 0 (no step-up). */ stepHeight?: number }
export interface MoveResult extends SweepResult {
  /** After the move, solid lies within GROUND_EPS below the box. */
  grounded: boolean
  /** A positive dy was stopped by solid above. */
  ceiling: boolean
  /** Rise added by step-up, already included in dy; 0 when no step was taken. For camera smoothing. */
  stepped: number
}
export interface LiquidInfo {
  /** Liquid height inside [minY, maxY] over the box height, 0..1: the max over the columns the footprint overlaps. */
  submerged: number
  /** eyeY was given and the point (box centre x, eyeY, box centre z) is under a liquid surface. */
  eyeUnder: boolean
  /** Top of the highest liquid run touching the box in the column that gave `submerged`; null when dry. */
  surfaceY: number | null
}
/** The functions bound to one world; what `engine.collision` is. */
export interface Collision {
  sweep(box: Box, delta: Vec3Like, out?: SweepResult): SweepResult
  move(box: Box, delta: Vec3Like, options?: MoveOptions, out?: MoveResult): MoveResult
  overlaps(box: Box): boolean
  groundDistance(box: Box, maxDown?: number): number | null
  liquid(box: Box, eyeY?: number): LiquidInfo
  liquidAt(x: number, y: number, z: number): boolean
  unstick(box: Box, maxUp: number): number | null
}

/** The box of a body whose feet centre is (x, y, z): [x−hw, x+hw] × [y, y+height] × [z−hw, z+hw]. */
export function bodyBox(x: number, y: number, z: number, halfWidth: number, height: number): Box {
  return { minX: x - halfWidth, minY: y, minZ: z - halfWidth, maxX: x + halfWidth, maxY: y + height, maxZ: z + halfWidth }
}

/** A working copy of a box: min x, y, z at 0..2, max x, y, z at 3..5. */
type Bounds = [number, number, number, number, number, number]

/** The box as Bounds, or null when any bound is not finite. */
function bounds(box: Box): Bounds | null {
  const b: Bounds = [box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ]
  for (const v of b) if (!Number.isFinite(v)) return null
  return b
}

/** The first cell an interval starting at lo overlaps: residue within CONTACT_EPS of a face is not overlap. */
function firstCell(lo: number): number { return Math.floor(lo + CONTACT_EPS) }
/** The last cell [lo, hi] overlaps; a degenerate interval counts as the cell holding lo, so ranges are never empty. */
function lastCell(lo: number, hi: number): number { return Math.max(firstCell(lo), Math.ceil(hi - CONTACT_EPS) - 1) }

/** Whether the inclusive cell range holds solid: outside the world's sides or floor is solid, above its top is air. */
function anySolid(w: CollisionWorld, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): boolean {
  const [sx, sy, sz] = w.size
  if (x0 < 0 || z0 < 0 || y0 < 0 || x1 >= sx || z1 >= sz) return true
  const top = Math.min(y1, sy - 1)
  for (let y = y0; y <= top; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    if (w.solid[voxelId(w.get(x, y, z))] === 1) return true
  }
  return false
}

function boxSolid(w: CollisionWorld, b: Bounds): boolean {
  return anySolid(w, firstCell(b[0]), lastCell(b[0], b[3]), firstCell(b[1]), lastCell(b[1], b[4]), firstCell(b[2]), lastCell(b[2], b[5]))
}

/** Whether the box overlaps a solid voxel (touching faces do not count). The game uses it to refuse placing a block inside a body. */
export function boxOverlapsSolid(w: CollisionWorld, box: Box): boolean {
  const b = bounds(box)
  return b !== null && boxSolid(w, b)
}
