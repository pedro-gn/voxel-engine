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

/** The delta as numbers; a non-finite component counts as 0. */
function delta3(d: Vec3Like): [number, number, number] {
  const [x, y, z] = 'x' in d ? [d.x, d.y, d.z] : [d[0], d[1], d[2]]
  return [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0, Number.isFinite(z) ? z : 0]
}

/**
 * Moves b along axis a (0 x, 1 y, 2 z) by d and returns the distance moved. Every slab of cells the leading face
 * enters is checked (so no length tunnels); cells the box already overlaps are not (so it can leave them). The scan
 * starts with residue tolerance and ends strictly, so tiny steps never creep into a face they touch.
 */
function sweepAxis(w: CollisionWorld, b: Bounds, a: number, d: number): number {
  if (d === 0) return 0
  const u = a === 0 ? 1 : 0, v = a === 2 ? 1 : 2
  const u0 = firstCell(b[u]), u1 = lastCell(b[u], b[u + 3]), v0 = firstCell(b[v]), v1 = lastCell(b[v], b[v + 3])
  const slab = (c: number) => a === 0 ? anySolid(w, c, c, u0, u1, v0, v1)
    : a === 1 ? anySolid(w, u0, u1, c, c, v0, v1) : anySolid(w, u0, u1, v0, v1, c, c)
  const top = w.size[1]
  let moved = d
  if (d > 0) {
    const f = b[a + 3]
    for (let c = Math.ceil(f - CONTACT_EPS); c < f + d; c++) {
      if (slab(c)) { moved = Math.max(0, c - f); break }
      if (a === 1 && c >= top) break // air from here up: the cross-section is inside the world
    }
  } else {
    const f = b[a]
    let c = Math.floor(f + CONTACT_EPS) - 1
    if (a === 1 && c >= top && !slab(c)) c = top - 1 // skip the air above the world
    for (; c + 1 > f + d; c--) {
      if (slab(c)) { moved = Math.min(0, c + 1 - f); break }
    }
  }
  b[a] += moved
  b[a + 3] += moved
  return moved
}

interface Horizontal { dx: number; dz: number; blockedX: boolean; blockedZ: boolean }

/** The horizontal phase: the axis with the larger |delta| first, x on a tie. */
function sweepHorizontal(w: CollisionWorld, b: Bounds, dx: number, dz: number, out: Horizontal): void {
  if (Math.abs(dz) > Math.abs(dx)) {
    out.dz = sweepAxis(w, b, 2, dz)
    out.dx = sweepAxis(w, b, 0, dx)
  } else {
    out.dx = sweepAxis(w, b, 0, dx)
    out.dz = sweepAxis(w, b, 2, dz)
  }
  out.blockedX = out.dx !== dx
  out.blockedZ = out.dz !== dz
}

/** Moves the box by delta, y first, then the larger horizontal axis; returns the allowed displacement. */
export function sweepBox(w: CollisionWorld, box: Box, delta: Vec3Like, out?: SweepResult): SweepResult {
  const r = out ?? { dx: 0, dy: 0, dz: 0, blockedX: false, blockedY: false, blockedZ: false }
  const b = bounds(box)
  if (b === null) {
    r.dx = 0; r.dy = 0; r.dz = 0
    r.blockedX = false; r.blockedY = false; r.blockedZ = false
    return r
  }
  const [dx, dy, dz] = delta3(delta)
  r.dy = sweepAxis(w, b, 1, dy)
  r.blockedY = r.dy !== dy
  sweepHorizontal(w, b, dx, dz, r)
  return r
}
