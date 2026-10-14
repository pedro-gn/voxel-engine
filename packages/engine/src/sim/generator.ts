import type { WorldSize } from '../world/layout.ts'
import { hash32 } from './rng.ts'

/** What a generator learns about the world when it receives a document. */
export interface GeneratorInfo {
  readonly size: WorldSize
  readonly seed: number
  /** Block name → id; throws for an unknown name. */
  id(name: string): number
}

/** What a generator may return from configure(). */
export interface GeneratorConfig {
  /** Water fills y < seaLevel; the pool at seaLevel − 1 is the sea that springs draw from. */
  seaLevel?: number
  /** The bottom of the volume is open: water, falling blocks, fragments and units leave the world there (spec §3). */
  void?: boolean
}

export interface GeneratorContext {
  readonly seed: number
  readonly height: number
  /**
   * The column's voxels, index lx + (lz << 5) + (y << 10), all air on entry. Writing here directly is
   * the fast path; `set` is the checked one.
   */
  readonly column: Uint16Array
  /** Local column coordinates: lx, lz in 0..31, y in 0..height-1. */
  set(lx: number, y: number, lz: number, voxel: number): void
  id(name: string): number
  noise2(x: number, z: number): number
  fbm2(x: number, z: number, octaves: number): number
}

export interface GeneratorModule {
  generateColumn(ctx: GeneratorContext, cx: number, cz: number): void
  /**
   * Receives the engine's `terrain` document before the first column, and again on every
   * `engine.terrain.setDocument`. Throw to reject the document; the error message reaches the caller.
   */
  configure?(doc: unknown, info: GeneratorInfo): void | GeneratorConfig
  /**
   * Applies an incremental change to the configured document (`engine.terrain.patch`). Throw to refuse
   * it; a refused patch must leave the generator as it was.
   */
  patch?(patch: unknown): void
}

export function defineGenerator(g: GeneratorModule): GeneratorModule {
  return g
}

/** The context the sim and the generation workers hand to `generateColumn`. */
export function makeColumnContext(seed: number, height: number, id: (name: string) => number, column: Uint16Array): GeneratorContext {
  return {
    seed,
    height,
    column,
    set: (lx, y, lz, v) => {
      if (!Number.isInteger(lx) || !Number.isInteger(y) || !Number.isInteger(lz) ||
          lx < 0 || lx > 31 || lz < 0 || lz > 31 || y < 0 || y >= height) {
        throw new RangeError(`generator write outside column: (${lx}, ${y}, ${lz})`)
      }
      column[lx + (lz << 5) + (y << 10)] = v
    },
    id,
    noise2: (x, z) => valueNoise2(seed, x, z),
    fbm2: (x, z, octaves) => fbm2(seed, x, z, octaves),
  }
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
