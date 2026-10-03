import { FEATURE_REACH, opBounds, type OpDef, type OpRegistry, type Rect, type TerrainDoc, type Vec2 } from '@elovox/terrain'

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
const GLOBAL_FIELDS = ['size', 'seaLevel', 'blocks', 'base', 'biomes', 'biomeRule', 'layers'] as const

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b)

/**
 * The area whose voxels can differ between two valid documents: every op added, removed or changed
 * (where it was and where it is) and every op whose order among the others changed. An op only
 * changes columns inside its bounds, so inserting or removing one leaves the rest alone.
 */
export function diffArea(prev: TerrainDoc, next: TerrainDoc, o: AreaOptions): Area {
  if (prev === next) return null
  for (const k of GLOBAL_FIELDS) if (!same(prev[k], next[k])) return 'all'
  const area = (def: OpDef, doc: TerrainDoc) => toArea(opBounds(def, doc, o), next.size)
  const before = new Map(prev.ops.map((op) => [op.id, op]))
  const after = new Map(next.ops.map((op) => [op.id, op]))
  let out: Area = null
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
