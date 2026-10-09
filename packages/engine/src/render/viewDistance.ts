/** Pure view-distance helpers (spec 4b §5): distances are 3D, from the eye to a box's nearest point, as the fog measures. */
export interface Vec3Like { x: number; y: number; z: number }

/** The camera far plane while the view distance is Infinity (as before 4b). */
export const DEFAULT_CAMERA_FAR = 3000
/** Share of R over which the edge fades to the fog colour: [R · (1 − EDGE_SHARE), R]. */
export const EDGE_SHARE = 0.25
/** Far plane past R: a chunk is kept while its nearest point is within R, so its far corner can be a chunk diagonal (55.4) beyond. */
export const FAR_MARGIN = 64
/** Edge band while the view distance is Infinity: smoothstep(OFF, 2 · OFF, d) is exactly 0 for any real distance. */
const OFF = 1e30

export function boxDistanceSq(px: number, py: number, pz: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  const dx = Math.max(x0 - px, 0, px - x1), dy = Math.max(y0 - py, 0, py - y1), dz = Math.max(z0 - pz, 0, pz - z1)
  return dx * dx + dy * dy + dz * dz
}

export function boxInRange(eye: Vec3Like, range: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): boolean {
  return range === Infinity || boxDistanceSq(eye.x, eye.y, eye.z, x0, y0, z0, x1, y1, z1) <= range * range
}

/** A chunk by its centre (cx, cy, cz): its 32³ box. */
export function chunkInRange(eye: Vec3Like, range: number, cx: number, cy: number, cz: number): boolean {
  return boxInRange(eye, range, cx - 16, cy - 16, cz - 16, cx + 16, cy + 16, cz + 16)
}

export function cameraFar(range: number): number {
  return range === Infinity ? DEFAULT_CAMERA_FAR : range + FAR_MARGIN
}

export function edgeBand(range: number): [number, number] {
  return range === Infinity ? [OFF, 2 * OFF] : [range * (1 - EDGE_SHARE), range]
}
