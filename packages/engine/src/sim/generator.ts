import { hash32 } from './rng.ts'

export interface GeneratorContext {
  readonly seed: number
  readonly height: number
  /** Local column coordinates: lx, lz in 0..31, y in 0..height-1. */
  set(lx: number, y: number, lz: number, voxel: number): void
  id(name: string): number
  noise2(x: number, z: number): number
  fbm2(x: number, z: number, octaves: number): number
}

export interface GeneratorModule {
  generateColumn(ctx: GeneratorContext, cx: number, cz: number): void
}

export function defineGenerator(g: GeneratorModule): GeneratorModule {
  return g
}

function lattice(seed: number, ix: number, iz: number): number {
  return hash32(seed, ix, iz) / 4294967296
}
function smooth(t: number): number { return t * t * (3 - 2 * t) }

/** Bilinear value noise in [0, 1). Arithmetic only, so it is identical on every JS engine. */
export function valueNoise2(seed: number, x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z)
  const fx = smooth(x - ix), fz = smooth(z - iz)
  const a = lattice(seed, ix, iz), b = lattice(seed, ix + 1, iz)
  const c = lattice(seed, ix, iz + 1), d = lattice(seed, ix + 1, iz + 1)
  const top = a + (b - a) * fx
  const bottom = c + (d - c) * fx
  return top + (bottom - top) * fz
}

export function fbm2(seed: number, x: number, z: number, octaves: number): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2(seed + o * 1013, x * freq, z * freq)
    norm += amp
    amp *= 0.5
    freq *= 2
  }
  return Math.min(sum / norm, 0.999999)
}
