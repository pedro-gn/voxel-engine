export const SIZE = 64
export const N = SIZE * SIZE
/** sRGB, 0–1 per channel. */
export type RGB = readonly [number, number, number]
export type Rand = () => number

export function rng(seed: number): Rand {
  let s = seed >>> 0 || 1
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296
}

/** Pixel index on the 64×64 torus: everything the painter draws wraps, so every tile is seamless. */
export function wrap(x: number, y: number): number {
  const xi = ((Math.floor(x) % SIZE) + SIZE) % SIZE
  const yi = ((Math.floor(y) % SIZE) + SIZE) % SIZE
  return yi * SIZE + xi
}

export function hex(h: string): RGB {
  const n = Number.parseInt(h.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
export function scaleRgb(c: RGB, k: number): RGB { return [c[0] * k, c[1] * k, c[2] * k] }
export function mixRgb(a: RGB, b: RGB, t: number): RGB { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] }
export function vary(c: RGB, r: Rand, amount: number): RGB { return scaleRgb(c, 1 + (r() - 0.5) * 2 * amount) }

/** A tile being painted: height drives the shading pass; colour is sRGB 0–1; alpha 0–1. */
export interface Layer { height: Float32Array; color: Float32Array; alpha: Float32Array }

export function createLayer(base: RGB, height = 0.5, alpha = 1): Layer {
  const l: Layer = { height: new Float32Array(N).fill(height), color: new Float32Array(N * 3), alpha: new Float32Array(N).fill(alpha) }
  for (let i = 0; i < N; i++) l.color.set(base, i * 3)
  return l
}

export function paint(l: Layer, i: number, c: RGB, h?: number, a?: number): void {
  l.color[i * 3] = c[0]; l.color[i * 3 + 1] = c[1]; l.color[i * 3 + 2] = c[2]
  if (h !== undefined) l.height[i] = h
  if (a !== undefined) l.alpha[i] = a
}

/** Calls fn for every pixel whose centre lies in the wrapped disc; d is distance / r (0 at the centre, 1 at the rim). */
export function disc(cx: number, cy: number, r: number, fn: (i: number, d: number) => void): void {
  for (let py = Math.floor(cy - r); py <= Math.ceil(cy + r); py++) for (let px = Math.floor(cx - r); px <= Math.ceil(cx + r); px++) {
    const d = Math.hypot(px + 0.5 - cx, py + 0.5 - cy) / r
    if (d <= 1) fn(wrap(px, py), d)
  }
}
