import { hash2, hash3 } from './hash.ts'

/** 8 unit gradients for 2D, flattened [x0, z0, x1, z1, …]. */
const G2 = new Float64Array([
  1, 0, -1, 0, 0, 1, 0, -1,
  Math.SQRT1_2, Math.SQRT1_2, -Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2, -Math.SQRT1_2, -Math.SQRT1_2, -Math.SQRT1_2,
])
/** The 12 cube-edge gradients of improved Perlin noise, plus 4 repeats so a 4-bit hash indexes them. */
const G3 = new Float64Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
  1, 1, 0, -1, 1, 0, 0, -1, 1, 0, -1, -1,
])

function fade(t: number): number { return t * t * t * (t * (t * 6 - 15) + 10) }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t }
function clamp1(v: number): number { return v < -1 ? -1 : v > 1 ? 1 : v }

function grad2(seed: number, ix: number, iz: number, dx: number, dz: number): number {
  const k = (hash2(seed, ix, iz) & 7) * 2
  return G2[k]! * dx + G2[k + 1]! * dz
}
function grad3(seed: number, ix: number, iy: number, iz: number, dx: number, dy: number, dz: number): number {
  const k = (hash3(seed, ix, iy, iz) & 15) * 3
  return G3[k]! * dx + G3[k + 1]! * dy + G3[k + 2]! * dz
}

/** 2D gradient noise in [-1, 1]; 0 at every integer lattice point. */
export function perlin2(seed: number, x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z)
  const fx = x - ix, fz = z - iz
  const u = fade(fx), v = fade(fz)
  const a = lerp(grad2(seed, ix, iz, fx, fz), grad2(seed, ix + 1, iz, fx - 1, fz), u)
  const b = lerp(grad2(seed, ix, iz + 1, fx, fz - 1), grad2(seed, ix + 1, iz + 1, fx - 1, fz - 1), u)
  return clamp1(lerp(a, b, v) * Math.SQRT2)
}

/** 3D gradient noise in [-1, 1]. */
export function perlin3(seed: number, x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z)
  const fx = x - ix, fy = y - iy, fz = z - iz
  const u = fade(fx), v = fade(fy), w = fade(fz)
  const x00 = lerp(grad3(seed, ix, iy, iz, fx, fy, fz), grad3(seed, ix + 1, iy, iz, fx - 1, fy, fz), u)
  const x10 = lerp(grad3(seed, ix, iy + 1, iz, fx, fy - 1, fz), grad3(seed, ix + 1, iy + 1, iz, fx - 1, fy - 1, fz), u)
  const x01 = lerp(grad3(seed, ix, iy, iz + 1, fx, fy, fz - 1), grad3(seed, ix + 1, iy, iz + 1, fx - 1, fy, fz - 1), u)
  const x11 = lerp(grad3(seed, ix, iy + 1, iz + 1, fx, fy - 1, fz - 1), grad3(seed, ix + 1, iy + 1, iz + 1, fx - 1, fy - 1, fz - 1), u)
  return clamp1(lerp(lerp(x00, x10, v), lerp(x01, x11, v), w))
}
