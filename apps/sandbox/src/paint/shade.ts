import { tileNoise } from './noise.ts'
import { N, SIZE, wrap, type Layer } from './raster.ts'

export interface ShadeOptions { cavity?: number; highlight?: number; baked?: number; jitter?: number; seed?: number }

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

function boxBlur(h: Float32Array, r: number): Float32Array {
  const tmp = new Float32Array(N), out = new Float32Array(N), n = 2 * r + 1
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    let s = 0
    for (let k = -r; k <= r; k++) s += h[wrap(x + k, y)]!
    tmp[y * SIZE + x] = s / n
  }
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    let s = 0
    for (let k = -r; k <= r; k++) s += tmp[wrap(x, y + k)]!
    out[y * SIZE + x] = s / n
  }
  return out
}

/** Hand-painted look from a height field: darkened cavities, lit edges (light from the top left), baked light, hue jitter. */
export function shade(l: Layer, o: ShadeOptions = {}): Uint8ClampedArray {
  const cavity = o.cavity ?? 0.45, highlight = o.highlight ?? 0.5, baked = o.baked ?? 0.3, jitter = o.jitter ?? 0.05, seed = o.seed ?? 1
  const h = l.height
  const blur = boxBlur(h, 2)
  const out = new Uint8ClampedArray(N * 4)
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = y * SIZE + x
    const cav = clamp01((blur[i]! - h[i]!) * 5)
    const gx = h[wrap(x + 1, y)]! - h[wrap(x - 1, y)]!
    const gy = h[wrap(x, y + 1)]! - h[wrap(x, y - 1)]!
    const edge = Math.min(1, Math.max(-1, (gx + gy) * 2.8))
    const k = (1 - cavity * cav) * (1 + highlight * edge) * (1 + baked * (h[i]! - 0.5))
    const j = jitter === 0 ? 0 : (tileNoise(seed, x, y, 4) - 0.5) * jitter
    out[i * 4] = Math.round(255 * clamp01(l.color[i * 3]! * k * (1 + j)))
    out[i * 4 + 1] = Math.round(255 * clamp01(l.color[i * 3 + 1]! * k * (1 + 0.6 * j)))
    out[i * 4 + 2] = Math.round(255 * clamp01(l.color[i * 3 + 2]! * k * (1 - 0.4 * j)))
    out[i * 4 + 3] = Math.round(255 * clamp01(l.alpha[i]!))
  }
  return out
}
