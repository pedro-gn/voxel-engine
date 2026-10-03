import type { BiomeDef, BiomeRule, SurfaceRule, TreeKind } from '../doc/types.ts'
import { makeNoise2 } from '../noise/def.ts'

/** What surface rules see about one solid voxel. */
export interface SurfaceInput {
  /** Solid voxels between this one and the nearest air or water above. 0 = exposed. */
  depth: number
  slope: number
  y: number
  /** The nearest non-solid voxel above is water. */
  underwater: boolean
  /** Water reference of the column (max of river/lake wet level and sea level). */
  wetRef: number
  /** The voxel right below is air. */
  ceiling: boolean
}

interface CompiledRule {
  block: number
  d0: number; d1: number
  s0: number; s1: number
  y0: number; y1: number
  /** -1 any, 0 must be false, 1 must be true */
  underwater: number
  ceiling: number
  /** -1 = any */
  nearWater: number
  bands: Int32Array | null
  thickness: number
}

export interface CompiledBiome {
  readonly name: string
  readonly rules: readonly CompiledRule[]
  /** Deepest depth any rule can match; deeper voxels take the fill block without checking rules. */
  readonly maxDepth: number
  readonly trees: { density: number; kinds: readonly TreeKind[]; on: ReadonlySet<number> } | null
  readonly rocks: { density: number; size: readonly [number, number] } | null
}

const tri = (v: boolean | undefined) => (v === undefined ? -1 : v ? 1 : 0)

function compileRule(r: SurfaceRule, id: (name: string) => number): CompiledRule {
  return {
    block: r.block === undefined ? 0 : id(r.block),
    d0: r.depth?.[0] ?? 0, d1: r.depth?.[1] ?? 0,
    s0: r.slope?.[0] ?? -Infinity, s1: r.slope?.[1] ?? Infinity,
    y0: r.y?.[0] ?? -Infinity, y1: r.y?.[1] ?? Infinity,
    underwater: tri(r.underwater), ceiling: tri(r.ceiling),
    nearWater: r.nearWater ?? -1,
    bands: r.bands ? Int32Array.from(r.bands.blocks, id) : null,
    thickness: r.bands?.thickness ?? 1,
  }
}

export function compileBiome(b: BiomeDef, id: (name: string) => number): CompiledBiome {
  const rules = b.surface.map((r) => compileRule(r, id))
  return {
    name: b.name,
    rules,
    maxDepth: rules.reduce((m, r) => Math.max(m, r.d1), -1),
    trees: b.trees ? { density: b.trees.density, kinds: b.trees.kinds, on: new Set((b.trees.on ?? ['grass']).map(id)) } : null,
    rocks: b.rocks ? { density: b.rocks.density, size: b.rocks.size } : null,
  }
}

/** The block for a solid voxel: the first matching rule of the biome, else `fill`. */
export function surfaceBlock(b: CompiledBiome, fill: number, i: SurfaceInput): number {
  if (i.depth > b.maxDepth) return fill
  for (const r of b.rules) {
    if (i.depth < r.d0 || i.depth > r.d1) continue
    if (i.slope < r.s0 || i.slope > r.s1) continue
    if (i.y < r.y0 || i.y > r.y1) continue
    if (r.underwater !== -1 && r.underwater !== (i.underwater ? 1 : 0)) continue
    if (r.ceiling !== -1 && r.ceiling !== (i.ceiling ? 1 : 0)) continue
    if (r.nearWater >= 0 && i.y > i.wetRef + r.nearWater) continue
    if (r.bands) {
      const n = r.bands.length
      return r.bands[((Math.floor(i.y / r.thickness) % n) + n) % n]!
    }
    return r.block
  }
  return fill
}

/** The default biome of a column of ground height `h`, from the document's biomeRule. */
export function compileBiomeRule(rule: BiomeRule, index: (name: string) => number, seed: number): (x: number, z: number, h: number) => number {
  const fallback = index(rule.default)
  const entries = (rule.rules ?? []).map((e) => ({
    biome: index(e.biome),
    min: e.minHeight ?? -Infinity, max: e.maxHeight ?? Infinity,
    m0: e.moisture?.[0] ?? -Infinity, m1: e.moisture?.[1] ?? Infinity,
  }))
  const needsMoisture = entries.some((e) => e.m0 !== -Infinity || e.m1 !== Infinity)
  const moisture = makeNoise2(rule.moisture ?? { scale: 300 }, seed ^ 0x6d6f6973)
  return (x, z, h) => {
    const m = needsMoisture ? moisture(x, z) : 0
    for (const e of entries) if (h >= e.min && h <= e.max && m >= e.m0 && m <= e.m1) return e.biome
    return fallback
  }
}
