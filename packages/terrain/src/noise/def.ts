import { cellular2, cellular3 } from './cellular.ts'
import { billow2, billow3, fbm2, fbm3, ridged2, ridged3, type Octaves } from './fractal.ts'

export type NoiseType = 'fbm' | 'ridged' | 'billow' | 'cellular'
export const NOISE_TYPES: readonly NoiseType[] = ['fbm', 'ridged', 'billow', 'cellular']

/** A noise description as it appears in a terrain document. */
export interface NoiseDef {
  /** Default 'fbm'. */
  type?: NoiseType
  /** Feature size in blocks: the sampler reads noise at (x / scale, z / scale). */
  scale: number
  /** Default 4. Ignored by 'cellular'. */
  octaves?: number
  /** Default 2. */
  lacunarity?: number
  /** Default 0.5. */
  gain?: number
  /** Added to the world seed, so two ops with the same noise can still differ. Default 0. */
  seed?: number
  /** Domain warp: offsets the sample point by fbm noise of this feature size and amount (blocks). */
  warp?: { scale: number; amount: number }
}

export type Sampler2 = (x: number, z: number) => number
export type Sampler3 = (x: number, y: number, z: number) => number

const WARP_X = 0x68e31da4
const WARP_Z = 0x1b56c4e9
const WARP_OCTAVES: Octaves = { octaves: 3, lacunarity: 2, gain: 0.5 }

function octavesOf(def: NoiseDef): Octaves {
  return { octaves: def.octaves ?? 4, lacunarity: def.lacunarity ?? 2, gain: def.gain ?? 0.5 }
}

/** A 2D sampler in [0, 1] for `def`, seeded from the world seed. */
export function makeNoise2(def: NoiseDef, worldSeed: number): Sampler2 {
  const seed = (worldSeed + (def.seed ?? 0)) | 0
  const inv = 1 / def.scale
  const o = octavesOf(def)
  const type = def.type ?? 'fbm'
  const base: Sampler2 =
    type === 'fbm' ? (x, z) => (fbm2(seed, x * inv, z * inv, o) + 1) * 0.5
    : type === 'ridged' ? (x, z) => ridged2(seed, x * inv, z * inv, o)
    : type === 'billow' ? (x, z) => (billow2(seed, x * inv, z * inv, o) + 1) * 0.5
    : (x, z) => cellular2(seed, x * inv, z * inv)
  const warp = def.warp
  if (!warp) return base
  const winv = 1 / warp.scale, amt = warp.amount
  return (x, z) => base(
    x + amt * fbm2(seed ^ WARP_X, x * winv, z * winv, WARP_OCTAVES),
    z + amt * fbm2(seed ^ WARP_Z, x * winv, z * winv, WARP_OCTAVES),
  )
}

/** A 3D sampler in [0, 1]. A warp, if any, offsets x and z only. */
export function makeNoise3(def: NoiseDef, worldSeed: number): Sampler3 {
  const seed = (worldSeed + (def.seed ?? 0)) | 0
  const inv = 1 / def.scale
  const o = octavesOf(def)
  const type = def.type ?? 'fbm'
  const base: Sampler3 =
    type === 'fbm' ? (x, y, z) => (fbm3(seed, x * inv, y * inv, z * inv, o) + 1) * 0.5
    : type === 'ridged' ? (x, y, z) => ridged3(seed, x * inv, y * inv, z * inv, o)
    : type === 'billow' ? (x, y, z) => (billow3(seed, x * inv, y * inv, z * inv, o) + 1) * 0.5
    : (x, y, z) => cellular3(seed, x * inv, y * inv, z * inv)
  const warp = def.warp
  if (!warp) return base
  const winv = 1 / warp.scale, amt = warp.amount
  return (x, y, z) => base(
    x + amt * fbm2(seed ^ WARP_X, x * winv, z * winv, WARP_OCTAVES),
    y,
    z + amt * fbm2(seed ^ WARP_Z, x * winv, z * winv, WARP_OCTAVES),
  )
}
