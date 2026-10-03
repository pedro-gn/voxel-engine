import { resolveBound, type OpDef, type OpImpl, type ParamSchema, type ShapeDef, type ShapeKind, type TerrainDoc, type Vec2 } from '@elovox/terrain'

/** Radius of a new circle. */
export const NEW_RADIUS = 48
/** Half the side of a new square, and half the length of a new path. */
export const NEW_HALF = 48
/** Width of a new path. */
export const NEW_WIDTH = 12

/** The smallest `${type}-${n}` (n ≥ 1) that no op in the document uses. */
export function nextOpId(doc: TerrainDoc, type: string): string {
  for (let n = 1; ; n++) {
    const id = `${type}-${n}`
    if (!doc.ops.some((o) => o.id === id)) return id
  }
}

/**
 * The params a new op starts with: every required number at its default (an anchored one relative to
 * `ground`, rounded and clamped into its bounds) and the document's first biome for a biome param.
 * Optional params are left out, so they follow their defaults.
 */
export function newParams(schema: ParamSchema, doc: TerrainDoc, ground: number, height: number): Record<string, unknown> {
  const ctx = { biomes: doc.biomes.map((b) => b.name), height }
  const out: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(schema)) {
    if (spec.type === 'biome') { out[key] = ctx.biomes[0]; continue }
    if (spec.type !== 'number' || !spec.required) continue
    let v = (spec.default ?? 0) + (spec.anchor === 'ground' ? Math.round(ground) : 0)
    if (spec.min !== undefined) v = Math.max(spec.min, v)
    const max = resolveBound(spec.max, ctx)
    if (max !== undefined) v = Math.min(max, v)
    out[key] = spec.int ? Math.round(v) : v
  }
  return out
}

/** A new shape centred on `at`: a circle, a square, or a straight path along x (with y = ground where needed). */
export function newShape(kind: ShapeKind, at: Vec2, needY: boolean, ground: number): ShapeDef {
  const x = Math.round(at[0]), z = Math.round(at[1])
  switch (kind) {
    case 'circle': return { kind, center: [x, z], radius: NEW_RADIUS }
    case 'polygon': return { kind, points: [[x - NEW_HALF, z - NEW_HALF], [x + NEW_HALF, z - NEW_HALF], [x + NEW_HALF, z + NEW_HALF], [x - NEW_HALF, z + NEW_HALF]] }
    case 'path': {
      const y = Math.round(ground)
      const point = (px: number) => (needY ? { x: px, z, y } : { x: px, z })
      return { kind, width: NEW_WIDTH, points: [point(x - NEW_HALF), point(x + NEW_HALF)] }
    }
  }
}

export interface NewOpPlace {
  /** Where the op goes (x, z). */
  at: Vec2
  /** Ground height there. */
  ground: number
  /** World height. */
  height: number
}

/** A valid new op of `impl`'s type and the given shape kind, ready for addOp. */
export function newOp(impl: OpImpl, kind: ShapeKind, doc: TerrainDoc, place: NewOpPlace): OpDef {
  return {
    id: nextOpId(doc, impl.type),
    type: impl.type,
    enabled: true,
    shape: newShape(kind, place.at, impl.needY ?? false, place.ground),
    params: newParams(impl.params, doc, place.ground, place.height),
  }
}
