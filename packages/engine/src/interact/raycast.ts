import type { WorldSize } from '../world/layout.ts'

export type Vec3Like = { x: number; y: number; z: number } | readonly [number, number, number]
export interface RayHit { pos: [number, number, number]; normal: [number, number, number]; voxel: number; distance: number }

function arr(v: Vec3Like): [number, number, number] {
  return 'x' in v ? [v.x, v.y, v.z] : [v[0], v[1], v[2]]
}

export function raycast(
  get: (x: number, y: number, z: number) => number,
  pickable: (voxel: number) => boolean,
  size: WorldSize,
  origin: Vec3Like,
  direction: Vec3Like,
  maxDist: number,
): RayHit | null {
  const o = arr(origin)
  const d = arr(direction)

  // Defensive checks for non-finite inputs
  if (!Number.isFinite(o[0]) || !Number.isFinite(o[1]) || !Number.isFinite(o[2])) return null
  // Rejects NaN and negatives. Infinity is fine: the walk always stops at the world box.
  if (!(maxDist >= 0)) return null

  // Math.sqrt is correctly rounded; Math.hypot is implementation-approximated and would break replay across engines.
  const len = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2])
  if (!(len > 0) || !Number.isFinite(len)) return null
  d[0] /= len; d[1] /= len; d[2] /= len

  // Clip to the world box [0, size).
  let tEnter = 0
  let tExit = Infinity
  let enterAxis = -1
  for (let a = 0; a < 3; a++) {
    if (d[a] === 0) {
      if (o[a]! < 0 || o[a]! >= size[a]!) return null
      continue
    }
    let t0 = (0 - o[a]!) / d[a]!
    let t1 = (size[a]! - o[a]!) / d[a]!
    if (t0 > t1) [t0, t1] = [t1, t0]
    if (t0 > tEnter) { tEnter = t0; enterAxis = a }
    tExit = Math.min(tExit, t1)
  }
  if (tEnter > tExit || tEnter > maxDist) return null

  const p = [o[0] + d[0] * tEnter, o[1] + d[1] * tEnter, o[2] + d[2] * tEnter]
  const v: [number, number, number] = [0, 0, 0]
  for (let a = 0; a < 3; a++) {
    v[a] = Math.min(size[a]! - 1, Math.max(0, Math.floor(p[a]! + (a === enterAxis ? d[a]! * 1e-9 : 0))))
  }
  const first = get(v[0], v[1], v[2])
  if (pickable(first)) {
    const normal: [number, number, number] = [0, 0, 0]
    if (enterAxis >= 0) normal[enterAxis] = d[enterAxis]! > 0 ? -1 : 1
    return { pos: [v[0], v[1], v[2]], normal, voxel: first, distance: tEnter }
  }

  const step = [Math.sign(d[0]), Math.sign(d[1]), Math.sign(d[2])]
  const tDelta = [Math.abs(1 / d[0]), Math.abs(1 / d[1]), Math.abs(1 / d[2])]
  const tMax = [0, 0, 0]
  for (let a = 0; a < 3; a++) {
    if (step[a] === 0) tMax[a] = Infinity
    else if (step[a]! > 0) tMax[a] = (v[a]! + 1 - p[a]!) / d[a]!
    else tMax[a] = (p[a]! - v[a]!) / -d[a]!
  }
  for (;;) {
    const a = tMax[0]! < tMax[1]! ? (tMax[0]! < tMax[2]! ? 0 : 2) : (tMax[1]! < tMax[2]! ? 1 : 2)
    const t = tEnter + tMax[a]!
    if (t > maxDist) return null
    v[a] += step[a]!
    if (v[a]! < 0 || v[a]! >= size[a]!) return null
    tMax[a] += tDelta[a]!
    const voxel = get(v[0], v[1], v[2])
    if (pickable(voxel)) {
      const normal: [number, number, number] = [0, 0, 0]
      normal[a] = -step[a]!
      return { pos: [v[0], v[1], v[2]], normal, voxel, distance: t }
    }
  }
}
