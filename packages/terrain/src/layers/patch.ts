import { Check } from '../doc/check.ts'
import type { TerrainLayers } from '../doc/types.ts'
import type { CompiledTerrain } from '../pipeline/compile.ts'
import { BIOME_TILE, BIOME_VALUES, BRICK_SPAN, BRICK_VALUES, HEIGHT_VALUES, TILE, brickKey, tileKey, type LayerLimits, type LayerValues } from './tiles.ts'

/** Tiles to replace in the configured document's layers; a null `values` removes the tile. Sent by engine.terrain.patch. */
export interface TerrainPatch {
  height?: { x: number; z: number; values: Int16Array | null }[]
  biome?: { x: number; z: number; values: Uint8Array | null }[]
  density?: { x: number; y: number; z: number; values: Int8Array | null }[]
}

/** The tiles of `b` that `a` does not share (by object identity), plus removals for the tiles only `a` has. */
export function diffLayers(a: TerrainLayers, b: TerrainLayers): TerrainPatch {
  const out: TerrainPatch = {}
  const height = diff(a.height?.tiles, b.height?.tiles, (t) => tileKey(t.x, t.z))
  if (height.length > 0) out.height = height.map(([t, values]) => ({ x: t.x, z: t.z, values }))
  const biome = diff(a.biome?.tiles, b.biome?.tiles, (t) => tileKey(t.x, t.z))
  if (biome.length > 0) out.biome = biome.map(([t, values]) => ({ x: t.x, z: t.z, values }))
  const density = diff(a.density?.bricks, b.density?.bricks, (t) => brickKey(t.x, t.y, t.z))
  if (density.length > 0) out.density = density.map(([t, values]) => ({ x: t.x, y: t.y, z: t.z, values }))
  return out
}

function diff<T extends { values: unknown }>(a: readonly T[] = [], b: readonly T[] = [], key: (t: T) => number): [T, T['values'] | null][] {
  const before = new Map(a.map((t) => [key(t), t]))
  const kept = new Set<number>()
  const out: [T, T['values'] | null][] = []
  for (const t of b) {
    const k = key(t)
    kept.add(k)
    if (before.get(k) !== t) out.push([t, t.values])
  }
  for (const [k, t] of before) if (!kept.has(k)) out.push([t, null])
  return out
}

const NAMES = { height: 'an Int16Array', biome: 'a Uint8Array', density: 'an Int8Array' } as const

/** Errors in a patch for a world with these limits, each as "path: message". */
export function checkPatch(p: unknown, o: LayerLimits): string[] {
  const c = new Check()
  if (!c.obj('patch', p)) return c.errors
  for (const k of Object.keys(p)) {
    if (k !== 'height' && k !== 'biome' && k !== 'density') c.fail(`patch.${k}`, 'unknown layer (known: height, biome, density)')
  }
  const tx = Math.ceil(o.sizeX / TILE), tz = Math.ceil(o.sizeZ / TILE)
  entries(c, 'height', p.height, [tx, tz], Int16Array, HEIGHT_VALUES)
  const biome = entries(c, 'biome', p.biome, [tx, tz], Uint8Array, BIOME_VALUES)
  biome.forEach(([i, values]) => {
    const at = values.findIndex((v) => v > o.biomeCount)
    if (at >= 0) c.fail(`patch.biome[${i}].values`, `value ${values[at]} at cell (${at % BIOME_TILE}, ${Math.floor(at / BIOME_TILE)}) exceeds the ${o.biomeCount} biomes`)
  })
  entries(c, 'density', p.density, [Math.ceil(o.sizeX / BRICK_SPAN), Math.ceil(o.height / BRICK_SPAN), Math.ceil(o.sizeZ / BRICK_SPAN)], Int8Array, BRICK_VALUES)
  return c.errors
}

/** Checks one layer's entries; returns the index and values of each entry with valid values. */
function entries(c: Check, layer: keyof typeof NAMES, v: unknown, limits: number[], Ctor: new (n: number) => LayerValues, n: number): [number, LayerValues][] {
  const path = `patch.${layer}`
  const out: [number, LayerValues][] = []
  if (!c.arr(path, v, 0, true)) return out
  const axes = limits.length === 3 ? (['x', 'y', 'z'] as const) : (['x', 'z'] as const)
  v.forEach((e, i) => {
    const p = `${path}[${i}]`
    if (!c.obj(p, e)) return
    axes.forEach((a, j) => c.num(`${p}.${a}`, e[a], { int: true, min: 0, max: limits[j]! - 1 }))
    if (e.values === null) return
    if (e.values instanceof Ctor && e.values.length === n) out.push([i, e.values])
    else c.fail(`${p}.values`, `must be null or ${NAMES[layer]} of ${n} values`)
  })
  return out
}

/** Replaces tiles in the compiled layers. The patch must have passed checkPatch. */
export function applyPatch(t: CompiledTerrain, p: TerrainPatch): void {
  for (const e of p.height ?? []) t.heightLayer.set(e.x, e.z, e.values)
  for (const e of p.biome ?? []) t.biomeLayer.set(e.x, e.z, e.values)
  for (const e of p.density ?? []) t.densityLayer.set(e.x, e.y, e.z, e.values)
}
