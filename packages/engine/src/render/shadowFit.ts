export type V3 = readonly [number, number, number]

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k]
const add = (...vs: V3[]): V3 => vs.reduce<V3>((s, v) => [s[0] + v[0], s[1] + v[1], s[2] + v[2]], [0, 0, 0])
function norm(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2])
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]
}

/** halfSize is quantised to this many blocks, so it doesn't change (and re-blur) on every small camera move. */
export const HALF_STEP = 8
const PAD = 2

export function frustumCorners(position: V3, forward: V3, up: V3, fovYDeg: number, aspect: number, near: number, far: number): V3[] {
  const f = norm(forward)
  const r = norm(cross(f, up))
  const u = cross(r, f)
  const tan = Math.tan((fovYDeg * Math.PI) / 360)
  const out: V3[] = []
  for (const d of [near, far]) {
    const hh = d * tan, hw = hh * aspect
    const c = add(position, scale(f, d))
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) out.push(add(c, scale(r, sx * hw), scale(u, sy * hh)))
  }
  return out
}

export interface ShadowFit { position: V3; target: V3; up: V3; halfSize: number; near: number; far: number; texel: number }

export function fitShadow(corners: readonly V3[], sunDir: V3, mapSize: number, minY: number, maxY: number): ShadowFit {
  const f = norm([-sunDir[0], -sunDir[1], -sunDir[2]])
  let r = cross(f, [0, 1, 0])
  if (Math.hypot(r[0], r[1], r[2]) < 1e-4) r = cross(f, [0, 0, 1])
  r = norm(r)
  const u = cross(r, f)
  let r0 = Infinity, r1 = -Infinity, u0 = Infinity, u1 = -Infinity, f0 = Infinity, f1 = -Infinity
  for (const c of corners) {
    const p: V3 = [c[0], Math.min(maxY, Math.max(minY, c[1])), c[2]]
    const pr = dot(p, r), pu = dot(p, u), pf = dot(p, f)
    r0 = Math.min(r0, pr); r1 = Math.max(r1, pr)
    u0 = Math.min(u0, pu); u1 = Math.max(u1, pu)
    f0 = Math.min(f0, pf, dot([c[0], maxY, c[2]], f)); f1 = Math.max(f1, pf)
  }
  const halfSize = Math.ceil((Math.max(r1 - r0, u1 - u0) / 2 + PAD) / HALF_STEP) * HALF_STEP
  const texel = (2 * halfSize) / mapSize
  const cr = Math.round((r0 + r1) / 2 / texel) * texel
  const cu = Math.round((u0 + u1) / 2 / texel) * texel
  const back = f0 - PAD
  const position = add(scale(r, cr), scale(u, cu), scale(f, back))
  return { position, target: add(position, f), up: u, halfSize, near: 0, far: f1 + PAD - back, texel }
}

/** How far from the camera shadows reach, from the orbit camera's distance to its target. */
export function shadowDistance(orbitDistance: number): number {
  return Math.min(700, Math.max(96, 3 * orbitDistance))
}
