import type { BaseDef, BlendMode, OpDef, PathPoint, ShapeDef, TerrainDoc, Vec2 } from '@elovox/terrain'

/** A change to a document: returns a new document that shares every unchanged part. Never mutates its input. */
export type Edit = (doc: TerrainDoc) => TerrainDoc

function indexOf(doc: TerrainDoc, id: string): number {
  const i = doc.ops.findIndex((o) => o.id === id)
  if (i < 0) throw new Error(`no op "${id}"`)
  return i
}

function mapOp(id: string, f: (op: OpDef) => OpDef): Edit {
  return (doc) => {
    const i = indexOf(doc, id)
    const ops = doc.ops.slice()
    ops[i] = f(doc.ops[i]!)
    return { ...doc, ops }
  }
}

function withPoints(shape: ShapeDef, f: (points: (Vec2 | PathPoint)[]) => void): ShapeDef {
  if (shape.kind === 'circle') throw new Error('a circle has no vertices')
  const points: (Vec2 | PathPoint)[] = shape.points.slice()
  f(points)
  return { ...shape, points } as ShapeDef
}

export function addOp(op: OpDef, index?: number): Edit {
  return (doc) => {
    const ops = doc.ops.slice()
    ops.splice(index ?? ops.length, 0, op)
    return { ...doc, ops }
  }
}

export function removeOp(id: string): Edit {
  return (doc) => {
    const i = indexOf(doc, id)
    return { ...doc, ops: doc.ops.filter((_, j) => j !== i) }
  }
}

export function replaceOp(id: string, op: OpDef): Edit {
  return mapOp(id, () => op)
}

export function setEnabled(id: string, enabled: boolean): Edit {
  return mapOp(id, (op) => ({ ...op, enabled }))
}

/** Moves an op `delta` places (negative = earlier), clamped to the list. */
export function reorderOp(id: string, delta: number): Edit {
  return (doc) => {
    const i = indexOf(doc, id)
    const j = Math.max(0, Math.min(doc.ops.length - 1, i + delta))
    if (j === i) return doc
    const ops = doc.ops.slice()
    const [op] = ops.splice(i, 1)
    ops.splice(j, 0, op!)
    return { ...doc, ops }
  }
}

/** Sets params[key]; `undefined` removes it (the param falls back to its default). */
export function setParam(id: string, key: string, value: unknown): Edit {
  return mapOp(id, (op) => {
    const params = { ...op.params }
    if (value === undefined) delete params[key]
    else params[key] = value
    return { ...op, params }
  })
}

/** Sets the blend; `undefined` removes it (the op type's default blend applies). */
export function setBlend(id: string, blend: BlendMode | undefined): Edit {
  return mapOp(id, (op) => {
    const { blend: _old, ...rest } = op
    return blend === undefined ? rest : { ...rest, blend }
  })
}

export function setShape(id: string, shape: ShapeDef): Edit {
  return mapOp(id, (op) => ({ ...op, shape }))
}

export function moveVertex(id: string, index: number, point: Vec2 | PathPoint): Edit {
  return mapOp(id, (op) => ({ ...op, shape: withPoints(op.shape, (p) => { p[index] = point }) }))
}

export function insertVertex(id: string, index: number, point: Vec2 | PathPoint): Edit {
  return mapOp(id, (op) => ({ ...op, shape: withPoints(op.shape, (p) => { p.splice(index, 0, point) }) }))
}

export function removeVertex(id: string, index: number): Edit {
  return mapOp(id, (op) => ({ ...op, shape: withPoints(op.shape, (p) => { p.splice(index, 1) }) }))
}

export function setSeaLevel(level: number): Edit {
  return (doc) => ({ ...doc, seaLevel: level })
}

export function setBase(base: BaseDef): Edit {
  return (doc) => ({ ...doc, base })
}
