import {
  BIOME_CELL, BIOME_TILE, BRICK_SAMPLES, BRICK_SPACING, FEATURE_REACH, TILE, brickKey, opBounds, tileKey,
  type OpDef, type OpRegistry, type Rect, type TerrainDoc, type TerrainLayers, type Vec2,
} from '@elovox/terrain'

/** A half-open integer rectangle (x0 <= x < x1, z0 <= z < z1): the engine's TerrainRect. */
export interface AreaRect { x0: number; z0: number; x1: number; z1: number }
/** Where the world must be regenerated: a rectangle, everything, or nothing. */
export type Area = AreaRect | 'all' | null

/** A column reads one neighbour column for its slope and FEATURE_REACH blocks for trees and rocks. */
export const AREA_PAD = FEATURE_REACH + 1

/** A closed rectangle in blocks, padded by AREA_PAD, rounded out to chunk columns and clipped to the world; null if outside it. */
export function toArea(r: Rect, size: Vec2): AreaRect | null {
  const x0 = Math.max(0, Math.floor((r.x0 - AREA_PAD) / 32) * 32)
  const z0 = Math.max(0, Math.floor((r.z0 - AREA_PAD) / 32) * 32)
  const x1 = Math.min(size[0], Math.ceil((r.x1 + 1 + AREA_PAD) / 32) * 32)
  const z1 = Math.min(size[1], Math.ceil((r.z1 + 1 + AREA_PAD) / 32) * 32)
  return x0 < x1 && z0 < z1 ? { x0, z0, x1, z1 } : null
}

export function unionArea(a: Area, b: Area): Area {
  if (a === 'all' || b === 'all') return 'all'
  if (a === null) return b
  if (b === null) return a
  return { x0: Math.min(a.x0, b.x0), z0: Math.min(a.z0, b.z0), x1: Math.max(a.x1, b.x1), z1: Math.max(a.z1, b.z1) }
}

export interface AreaOptions { ops?: OpRegistry; height: number }

/** Document fields that apply everywhere: a change to any of them dirties the whole world. */
const GLOBAL_FIELDS = ['size', 'seaLevel', 'blocks', 'base', 'biomes', 'biomeRule'] as const

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

/**
 * The area whose voxels can differ between two valid documents: every layer value that changed, every op added, removed or changed
 * (where it was and where it is) and every op whose order among the others changed. An op only
 * changes columns inside its bounds, so inserting or removing one leaves the rest alone.
 */
export function diffArea(prev: TerrainDoc, next: TerrainDoc, o: AreaOptions): Area {
  if (prev === next) return null
  for (const k of GLOBAL_FIELDS) if (!same(prev[k], next[k])) return 'all'
  const area = (def: OpDef, doc: TerrainDoc) => toArea(opBounds(def, doc, o), next.size)
  const before = new Map(prev.ops.map((op) => [op.id, op]))
  const after = new Map(next.ops.map((op) => [op.id, op]))
  const layers = prev.layers === next.layers ? null : changedLayerRect(prev.layers, next.layers)
  let out: Area = layers ? toArea(layers, next.size) : null
  for (const [id, op] of before) {
    const now = after.get(id)
    if (now && same(op, now)) continue
    out = unionArea(out, area(op, prev))
    if (now) out = unionArea(out, area(now, next))
  }
  for (const [id, op] of after) if (!before.has(id)) out = unionArea(out, area(op, next))
  const common = (ops: readonly OpDef[]) => ops.filter((op) => before.has(op.id) && after.has(op.id)).map((op) => op.id)
  const a = common(prev.ops), b = common(next.ops)
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    out = unionArea(out, area(before.get(a[i]!)!, prev))
    out = unionArea(out, area(after.get(b[i]!)!, next))
  }
  return out
}

/** Whether two documents differ in nothing but their layers (every other field is the same object). */
export function onlyLayersDiffer(a: TerrainDoc, b: TerrainDoc): boolean {
  const keys = Object.keys(a) as (keyof TerrainDoc)[]
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((k) => k === 'layers' || a[k] === b[k])
}

/** A closed rectangle that grows to cover what it is given. */
class Bounds {
  rect: Rect | null = null
  add(x0: number, z0: number, x1: number, z1: number): void {
    const r = this.rect
    this.rect = r
      ? { x0: Math.min(r.x0, x0), z0: Math.min(r.z0, z0), x1: Math.max(r.x1, x1), z1: Math.max(r.z1, z1) }
      : { x0, z0, x1, z1 }
  }
}

/**
 * The columns whose layer values differ between two documents, as a closed rectangle in blocks, or
 * null. Tiles both documents share are skipped without reading them. A changed density sample reaches
 * BRICK_SPACING blocks around it (trilinear interpolation).
 */
export function changedLayerRect(a: TerrainLayers, b: TerrainLayers): Rect | null {
  const out = new Bounds()
  changed(a.height?.tiles, b.height?.tiles, (t) => tileKey(t.x, t.z), (t, i) => {
    const x = t.x * TILE + (i % TILE), z = t.z * TILE + Math.floor(i / TILE)
    out.add(x, z, x, z)
  })
  changed(a.biome?.tiles, b.biome?.tiles, (t) => tileKey(t.x, t.z), (t, i) => {
    const x = t.x * TILE + (i % BIOME_TILE) * BIOME_CELL, z = t.z * TILE + Math.floor(i / BIOME_TILE) * BIOME_CELL
    out.add(x, z, x + BIOME_CELL - 1, z + BIOME_CELL - 1)
  })
  changed(a.density?.bricks, b.density?.bricks, (t) => brickKey(t.x, t.y, t.z), (t, i) => {
    const x = (t.x * BRICK_SAMPLES + (i % BRICK_SAMPLES)) * BRICK_SPACING
    const z = (t.z * BRICK_SAMPLES + (Math.floor(i / BRICK_SAMPLES) % BRICK_SAMPLES)) * BRICK_SPACING
    out.add(x - BRICK_SPACING, z - BRICK_SPACING, x + BRICK_SPACING, z + BRICK_SPACING)
  })
  return out.rect
}

/** Calls `visit` for every value index that differs between two tile lists; a missing tile reads as zeros. */
function changed<T extends { values: ArrayLike<number> }>(a: readonly T[] = [], b: readonly T[] = [], key: (t: T) => number, visit: (t: T, i: number) => void): void {
  const before = new Map(a.map((t) => [key(t), t]))
  const seen = new Set<number>()
  for (const tb of b) {
    const k = key(tb)
    seen.add(k)
    const ta = before.get(k)
    if (ta === tb) continue
    for (let i = 0; i < tb.values.length; i++) if ((ta ? ta.values[i]! : 0) !== tb.values[i]) visit(tb, i)
  }
  for (const [k, ta] of before) {
    if (seen.has(k)) continue
    for (let i = 0; i < ta.values.length; i++) if (ta.values[i] !== 0) visit(ta, i)
  }
}
