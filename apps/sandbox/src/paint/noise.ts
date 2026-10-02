import { SIZE } from './raster.ts'

function hash2(seed: number, i: number, j: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i + 0x632be5ab, 0xc2b2ae35) ^ Math.imul(j + 0x1b873593, 0x27d4eb2f)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}
const smooth = (t: number) => t * t * (3 - 2 * t)
const mod = (a: number, n: number) => ((a % n) + n) % n

/** [0, 1) for any integer id. */
export function hashId(id: number): number { return hash2(0x51ed27, id, 0) }

/** Value noise on a px × py lattice spanning the tile, so it repeats every SIZE pixels on both axes. [0, 1). */
export function tileNoise(seed: number, x: number, y: number, px: number, py = px): number {
  const fx = (x / SIZE) * px, fy = (y / SIZE) * py
  const ix = Math.floor(fx), iy = Math.floor(fy)
  const tx = smooth(fx - ix), ty = smooth(fy - iy)
  const L = (i: number, j: number) => hash2(seed, mod(i, px), mod(j, py))
  const top = L(ix, iy) + (L(ix + 1, iy) - L(ix, iy)) * tx
  const bottom = L(ix, iy + 1) + (L(ix + 1, iy + 1) - L(ix, iy + 1)) * tx
  return top + (bottom - top) * ty
}

export function tileFbm(seed: number, x: number, y: number, period: number, octaves: number): number {
  let sum = 0, amp = 0.5, norm = 0, p = period
  for (let o = 0; o < octaves; o++) {
    sum += amp * tileNoise(seed + o * 101, x, y, p)
    norm += amp
    amp *= 0.5
    p *= 2
  }
  return Math.min(sum / norm, 0.999999)
}

/** Wrapped Worley noise on a cells × cells grid (cells must divide SIZE): nearest and second-nearest distances in cell units. */
export function worley(seed: number, x: number, y: number, cells: number): { d: number; d2: number; id: number } {
  const cs = SIZE / cells
  const fx = mod(x, SIZE) / cs, fy = mod(y, SIZE) / cs
  const ix = Math.floor(fx), iy = Math.floor(fy)
  let d = Infinity, d2 = Infinity, id = 0
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    const cx = ix + ox, cy = iy + oy
    const wx = mod(cx, cells), wy = mod(cy, cells)
    const dist = Math.hypot(cx + hash2(seed, wx, wy) - fx, cy + hash2(seed + 1, wx, wy) - fy)
    if (dist < d) { d2 = d; d = dist; id = wy * cells + wx } else if (dist < d2) d2 = dist
  }
  return { d, d2, id }
}
