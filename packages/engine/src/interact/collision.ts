import type { WorldSize } from '../world/layout.ts'
import { voxelId, voxelState } from '../world/voxel.ts'
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

/** Solid lies within GROUND_EPS below b. */
function resting(w: CollisionWorld, b: Bounds): boolean {
  const probe: Bounds = [...b]
  return sweepAxis(w, probe, 1, -GROUND_EPS) !== -GROUND_EPS
}

/** How far the box drops before resting on solid, if within maxDown (default GROUND_EPS); null otherwise. */
export function groundDistance(w: CollisionWorld, box: Box, maxDown = GROUND_EPS): number | null {
  const b = bounds(box)
  if (b === null) return null
  const reach = Number.isFinite(maxDown) && maxDown > 0 ? maxDown : GROUND_EPS
  const moved = sweepAxis(w, b, 1, -reach)
  return moved === -reach ? null : 0 - moved // 0 − moved: never −0
}

/**
 * sweepBox plus step-up (spec §4 Step-up): when stepHeight > 0, a horizontal axis is blocked and the box rests on
 * solid after the y phase, it also tries lift → horizontal → drop by the lift, and keeps that path only if it gets
 * strictly further horizontally.
 */
export function moveBox(w: CollisionWorld, box: Box, delta: Vec3Like, options?: MoveOptions, out?: MoveResult): MoveResult {
  const r = out ?? { dx: 0, dy: 0, dz: 0, blockedX: false, blockedY: false, blockedZ: false, grounded: false, ceiling: false, stepped: 0 }
  r.grounded = false
  r.ceiling = false
  r.stepped = 0
  const start = bounds(box)
  if (start === null) { sweepBox(w, box, delta, r); return r }
  const [dx, dy, dz] = delta3(delta)
  let b = start
  r.dy = sweepAxis(w, b, 1, dy)
  r.blockedY = r.dy !== dy
  r.ceiling = r.blockedY && dy > 0
  const afterY: Bounds = [...b]
  sweepHorizontal(w, b, dx, dz, r)
  const stepHeight = options?.stepHeight ?? 0
  if (stepHeight > 0 && Number.isFinite(stepHeight) && (r.blockedX || r.blockedZ) && resting(w, afterY)) {
    const s: Bounds = [...afterY]
    const lift = sweepAxis(w, s, 1, stepHeight)
    const h: Horizontal = { dx: 0, dz: 0, blockedX: false, blockedZ: false }
    sweepHorizontal(w, s, dx, dz, h)
    const drop = sweepAxis(w, s, 1, -lift)
    if (h.dx * h.dx + h.dz * h.dz > r.dx * r.dx + r.dz * r.dz) {
      r.dx = h.dx; r.dz = h.dz
      r.blockedX = h.blockedX; r.blockedZ = h.blockedZ
      r.stepped = lift + drop
      r.dy += r.stepped
      b = s
    }
  }
  r.grounded = resting(w, b)
  return r
}

/**
 * The smallest upward lift (≤ maxUp) after which the box overlaps no solid; 0 when it already overlaps none, null when
 * no lift up to maxUp frees it. Clearing a cell needs minY on that cell's top, so the candidates put minY on each
 * integer above it. Above the world's top only the sides can overlap, and lifting never clears those.
 */
export function unstick(w: CollisionWorld, box: Box, maxUp: number): number | null {
  const b = bounds(box)
  if (b === null) return null
  if (!boxSolid(w, b)) return 0
  if (!Number.isFinite(maxUp) || maxUp < 0) return null
  const top = w.size[1]
  for (let n = Math.floor(b[1]) + 1; n - b[1] <= maxUp && n <= top; n++) {
    const lift = n - b[1]
    if (!boxSolid(w, [b[0], n, b[2], b[3], b[4] + lift, b[5]])) return lift
  }
  return null
}

/** The liquid fill of cell (x, y, z) from the voxel water mirror: 0 dry, 1 a spring, else (level + 1) / 8. */
function fillOf(w: CollisionWorld, x: number, y: number, z: number): number {
  const [sx, sy, sz] = w.size
  if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return 0
  const v = w.get(x, y, z), id = voxelId(v)
  if (w.liquid[id] !== 1) return 0
  return w.source[id] === 1 ? 1 : ((voxelState(v) & 7) + 1) / 8
}

/** Whether the point (x, y, z) is under a liquid surface: inside a liquid voxel, below that voxel's fill. */
export function liquidAt(w: CollisionWorld, x: number, y: number, z: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false
  const cy = Math.floor(y)
  const f = fillOf(w, Math.floor(x), cy, Math.floor(z))
  return f > 0 && y < cy + f
}

/** The top of the highest liquid run in column (x, z) that has a liquid cell in [y0, y1]: climbs through full cells. */
function surfaceAt(w: CollisionWorld, x: number, z: number, y0: number, y1: number): number {
  let y = y1
  while (y > y0 && fillOf(w, x, y, z) === 0) y--
  let f = fillOf(w, x, y, z)
  while (f === 1) {
    const g = fillOf(w, x, y + 1, z)
    if (g === 0) break
    y++
    f = g
  }
  return y + f
}

/** How deep the box is in liquid (spec §4 Liquid), read from the voxel water mirror; eyeY tests a point at the box centre. */
export function liquidInBox(w: CollisionWorld, box: Box, eyeY?: number): LiquidInfo {
  const r: LiquidInfo = { submerged: 0, eyeUnder: false, surfaceY: null }
  const b = bounds(box)
  if (b === null) return r
  const [sx, sy, sz] = w.size
  const x0 = Math.max(0, firstCell(b[0])), x1 = Math.min(sx - 1, lastCell(b[0], b[3]))
  const z0 = Math.max(0, firstCell(b[2])), z1 = Math.min(sz - 1, lastCell(b[2], b[5]))
  const y0 = Math.max(0, firstCell(b[1])), y1 = Math.min(sy - 1, lastCell(b[1], b[4]))
  let best = 0, bx = 0, bz = 0
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    let wet = 0
    for (let y = y0; y <= y1; y++) {
      const f = fillOf(w, x, y, z)
      if (f > 0) wet += Math.max(0, Math.min(y + f, b[4]) - Math.max(y, b[1]))
    }
    if (wet > best) { best = wet; bx = x; bz = z }
  }
  const height = b[4] - b[1]
  if (best > 0) {
    r.submerged = height > 0 ? Math.min(1, best / height) : 0
    r.surfaceY = surfaceAt(w, bx, bz, y0, y1)
  }
  if (eyeY !== undefined) r.eyeUnder = liquidAt(w, (b[0] + b[3]) / 2, eyeY, (b[2] + b[5]) / 2)
  return r
}
