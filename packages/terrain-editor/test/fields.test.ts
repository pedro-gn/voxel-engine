import { describe, expect, it } from 'vitest'
import { builtinOps, type OpDef } from '@elovox/terrain'
import { docFields, opFields, walkFields, type Field, type GroupField, type NumberField, type SelectField } from '../src/ui/panels/fields.ts'
import { HEIGHT, doc } from './fixtures.ts'

const byPath = (fields: Field[]) => {
  const m = new Map<string, Field>()
  walkFields(fields, (f) => m.set(f.path, f))
  return m
}
const fieldsOf = (id: string) => {
  const d = doc()
  const def = d.ops.find((o) => o.id === id)!
  return { d, def, fields: byPath(opFields(def, builtinOps.get(def.type)!, d, HEIGHT)) }
}

describe('opFields', () => {
  it('lists blend, shape, params and points in order', () => {
    const d = doc()
    const def = d.ops.find((o) => o.id === 'pond')!
    expect(opFields(def, builtinOps.get('lake')!, d, HEIGHT).map((f) => f.path)).toEqual([
      'blend', 'shape.inset', 'params.level', 'params.depth', 'params.shore', 'params.shoreSlope', 'shape.points',
    ])
  })

  it('gives volume ops no blend and falloff only to falloff ops', () => {
    expect(fieldsOf('rock').fields.has('blend')).toBe(false)
    expect(fieldsOf('hill').fields.has('shape.falloff')).toBe(true)
    expect(fieldsOf('ridge').fields.has('shape.falloff')).toBe(false)
  })

  it('describes number params from the schema', () => {
    const amp = fieldsOf('hill').fields.get('params.amplitude') as NumberField
    expect(amp).toMatchObject({ value: 10, placeholder: 12, min: 0, max: 64, step: 0.1, optional: false })
    const offset = fieldsOf('hill').fields.get('params.offset') as NumberField
    expect(offset).toMatchObject({ value: undefined, placeholder: 0, optional: true })
    const level = fieldsOf('pond').fields.get('params.level') as NumberField
    expect(level).toMatchObject({ min: 1, max: 127, step: 1 })
  })

  it('makes edits that set and clear params', () => {
    const { d, fields } = fieldsOf('hill')
    expect((fields.get('params.offset') as NumberField).edit(4)(d).ops[0]!.params).toEqual({ amplitude: 10, offset: 4 })
    expect((fields.get('params.amplitude') as NumberField).edit(undefined)(d).ops[0]!.params).toEqual({})
  })

  it('offers the blend modes with the default first', () => {
    const { d, fields } = fieldsOf('hill')
    const blend = fields.get('blend') as SelectField
    expect(blend.value).toBe('')
    expect(blend.options.map((o) => o.value)).toEqual(['', 'add', 'carve', 'max', 'min', 'set'])
    expect(blend.options[0]!.label).toBe('default (add)')
    expect(blend.edit('max')(d).ops[0]!.blend).toBe('max')
  })

  it('edits the shape: radius, falloff (cleared when emptied) and centre', () => {
    const { d, fields } = fieldsOf('hill')
    expect((fields.get('shape.radius') as NumberField).edit(30)(d).ops[0]!.shape).toMatchObject({ radius: 30 })
    expect('falloff' in (fields.get('shape.falloff') as NumberField).edit(undefined)(d).ops[0]!.shape).toBe(false)
    expect((fields.get('shape.center[0]') as NumberField).edit(77)(d).ops[0]!.shape).toMatchObject({ center: [77, 64] })
  })

  it('lists path points with x, z and optional y and width', () => {
    const { d, fields } = fieldsOf('ridge')
    const p1 = fields.get('shape.points[1]') as GroupField
    expect(p1.fields.map((f) => f.path)).toEqual(['shape.points[1].x', 'shape.points[1].z', 'shape.points[1].y', 'shape.points[1].width'])
    const y = fields.get('shape.points[1].y') as NumberField
    expect(y).toMatchObject({ value: undefined, optional: true })
    expect(y.edit(12)(d).ops[1]!.shape).toMatchObject({ points: [{ x: 150, z: 40 }, { x: 200, z: 90, y: 12 }] })
    const withY = y.edit(12)(d)
    const cleared = (opFields(withY.ops[1]!, builtinOps.get('mountain')!, withY, HEIGHT).at(-1) as GroupField).fields[1] as GroupField
    expect((cleared.fields[2] as NumberField).edit(undefined)(withY).ops[1]!.shape).toMatchObject({ points: [{ x: 150, z: 40 }, { x: 200, z: 90 }] })
  })

  it('lists polygon points as x and z', () => {
    const { d, fields } = fieldsOf('pond')
    expect((fields.get('shape.points[0][1]') as NumberField).edit(170)(d).ops[2]!.shape).toMatchObject({ points: [[100, 170], [140, 180], [140, 220], [100, 220]] })
  })

  it('edits a noise param as a group, with warp as a toggle', () => {
    const { d, fields } = fieldsOf('hill')
    const noise = fields.get('params.noise') as GroupField
    expect(noise.fields.map((f) => f.path)).toEqual([
      'params.noise.type', 'params.noise.scale', 'params.noise.octaves', 'params.noise.lacunarity', 'params.noise.gain', 'params.noise.seed', 'params.noise.warp',
    ])
    const scale = fields.get('params.noise.scale') as NumberField
    expect(scale.value).toBe(64) // the schema default
    expect(scale.edit(80)(d).ops[0]!.params.noise).toEqual({ scale: 80 })
    const warp = fields.get('params.noise.warp') as Field & { kind: 'bool' }
    expect(warp.edit(true)(d).ops[0]!.params.noise).toEqual({ scale: 64, warp: { scale: 64, amount: 16 } })
  })

  it('offers the document biomes for a biome param', () => {
    const d = doc()
    const def: OpDef = { id: 'b', type: 'biome', enabled: true, shape: { kind: 'circle', center: [10, 10], radius: 5 }, params: { biome: 'mesa' } }
    const f = byPath(opFields(def, builtinOps.get('biome')!, d, HEIGHT)).get('params.biome') as SelectField
    expect(f.value).toBe('mesa')
    expect(f.options.map((o) => o.value)).toEqual(['plain', 'mesa'])
  })
})

describe('docFields', () => {
  it('edits the sea level and the base fill', () => {
    const d = doc()
    const f = byPath(docFields(d, HEIGHT))
    expect((f.get('seaLevel') as NumberField)).toMatchObject({ value: 10, min: 0, max: 127, step: 1 })
    expect((f.get('seaLevel') as NumberField).edit(12)(d).seaLevel).toBe(12)
    expect((f.get('base.amplitude') as NumberField).edit(6)(d).base).toEqual({ height: 30, amplitude: 6, noise: { scale: 64 } })
    expect((f.get('base.noise.octaves') as NumberField).edit(3)(d).base.noise).toEqual({ scale: 64, octaves: 3 })
  })
})
