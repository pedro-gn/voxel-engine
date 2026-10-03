import { Vector3, type Camera } from 'three/webgpu'

/** Canvas-relative CSS pixels. */
export interface ScreenPoint { x: number; y: number }
export interface Viewport { width: number; height: number }
export interface WorldRay { origin: Vector3; dir: Vector3 }

/** Where a world point appears on the canvas; null if it is behind the camera. */
export function toScreen(p: { x: number; y: number; z: number }, camera: Camera, vp: Viewport): ScreenPoint | null {
  const v = new Vector3(p.x, p.y, p.z).applyMatrix4(camera.matrixWorldInverse)
  if (v.z >= 0) return null // the camera looks down -z in view space
  v.applyMatrix4(camera.projectionMatrix)
  return { x: ((v.x + 1) / 2) * vp.width, y: ((1 - v.y) / 2) * vp.height }
}

/** The ray from the camera through a canvas point. */
export function rayAt(camera: Camera, vp: Viewport, at: ScreenPoint): WorldRay {
  const origin = new Vector3().setFromMatrixPosition(camera.matrixWorld)
  const p = new Vector3((at.x / vp.width) * 2 - 1, 1 - (at.y / vp.height) * 2, 0.5).unproject(camera)
  return { origin, dir: p.sub(origin).normalize() }
}

/** Where the ray meets the plane y = `y`; null if it runs parallel or the plane is behind it. */
export function hitHorizontal(ray: WorldRay, y: number): { x: number; z: number } | null {
  if (Math.abs(ray.dir.y) < 1e-6) return null
  const t = (y - ray.origin.y) / ray.dir.y
  if (t <= 0) return null
  return { x: ray.origin.x + ray.dir.x * t, z: ray.origin.z + ray.dir.z * t }
}

/**
 * The height where the ray meets the vertical plane through `through` whose horizontal normal is
 * `normal` (the camera's forward direction at the start of the drag); null if parallel or behind.
 */
export function hitVertical(ray: WorldRay, through: { x: number; z: number }, normal: { x: number; z: number }): number | null {
  const denom = ray.dir.x * normal.x + ray.dir.z * normal.z
  if (Math.abs(denom) < 1e-6) return null
  const t = ((through.x - ray.origin.x) * normal.x + (through.z - ray.origin.z) * normal.z) / denom
  if (t <= 0) return null
  return ray.origin.y + ray.dir.y * t
}

/** The item whose screen point is closest to `at`, within `radius` pixels. */
export function nearest<T>(items: readonly T[], screen: (t: T) => ScreenPoint | null, at: ScreenPoint, radius: number): T | null {
  let best: T | null = null
  let bestD = radius
  for (const item of items) {
    const s = screen(item)
    if (!s) continue
    const d = Math.hypot(s.x - at.x, s.y - at.y)
    if (d <= bestD) { best = item; bestD = d }
  }
  return best
}

function segmentDistance(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const ex = b.x - a.x, ey = b.y - a.y
  const len2 = ex * ex + ey * ey
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / len2)) : 0
  return Math.hypot(p.x - (a.x + ex * t), p.y - (a.y + ey * t))
}

/** Pixels from `at` to the nearest segment whose two ends are on screen; Infinity if there is none. */
export function distanceToPolyline(at: ScreenPoint, points: readonly (ScreenPoint | null)[], closed: boolean): number {
  let best = Infinity
  const n = points.length
  const segments = closed ? n : n - 1
  for (let i = 0; i < segments; i++) {
    const a = points[i], b = points[(i + 1) % n]
    if (a && b) best = Math.min(best, segmentDistance(at, a, b))
  }
  return best
}
