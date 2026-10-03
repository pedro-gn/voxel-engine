import { describe, expect, it } from 'vitest'
import { BUILTIN_OPS, builtinOps, validateTerrainDoc, type OpImpl } from '@elovox/terrain'
import { addOp } from '../src/core/edits.ts'
import { newOp, newParams, newShape, nextOpId } from '../src/core/newOp.ts'
import { HEIGHT, doc } from './fixtures.ts'

const impl = (type: string): OpImpl => builtinOps.get(type)!

describe('nextOpId', () => {
  it('takes the smallest free number', () => {
    const d = doc()
    expect(nextOpId(d, 'hills')).toBe('hills-1')
    const one = addOp(newOp(impl('hills'), 'circle', d, { at: [50, 50], ground: 30, height: HEIGHT }))(d)
    expect(nextOpId(one, 'hills')).toBe('hills-2')
  })
})

describe('newParams', () => {
  it('sets required params from their defaults, anchored heights from the ground, the first biome', () => {
    const d = doc()
    expect(newParams(impl('hills').params, d, 30, HEIGHT)).toEqual({ amplitude: 12 })
    expect(newParams(impl('plateau').params, d, 30, HEIGHT)).toEqual({ top: 54, base: 30 })
    expect(newParams(impl('river').params, d, 30, HEIGHT)).toEqual({ start: 30, end: 24 })
    expect(newParams(impl('biome').params, d, 30, HEIGHT)).toEqual({ biome: 'plain' })
  })

  it('clamps anchored heights into their bounds', () => {
    expect(newParams(impl('river').params, doc(), 3, HEIGHT)).toEqual({ start: 3, end: 1 })
    expect(newParams(impl('plateau').params, doc(), 120, HEIGHT)).toEqual({ top: 128, base: 120 })
  })
})

describe('newShape', () => {
  it('makes a circle, a square and a straight path around the point', () => {
    expect(newShape('circle', [100, 80], false, 30)).toEqual({ kind: 'circle', center: [100, 80], radius: 48 })
    expect(newShape('polygon', [100, 80], false, 30)).toEqual({ kind: 'polygon', points: [[52, 32], [148, 32], [148, 128], [52, 128]] })
    expect(newShape('path', [100, 80], false, 30)).toEqual({ kind: 'path', width: 12, points: [{ x: 52, z: 80 }, { x: 148, z: 80 }] })
    expect(newShape('path', [100, 80], true, 30)).toEqual({ kind: 'path', width: 12, points: [{ x: 52, z: 80, y: 30 }, { x: 148, z: 80, y: 30 }] })
  })
})

describe('newOp', () => {
  const cases = BUILTIN_OPS.flatMap((o) => o.shapes.map((kind) => [o.type, kind] as const))
  it.each(cases)('a new %s (%s) is a valid op', (type, kind) => {
    const d = doc()
    const op = newOp(impl(type), kind, d, { at: [128, 128], ground: 30, height: HEIGHT })
    expect(op).toMatchObject({ id: `${type}-1`, type, enabled: true })
    const r = validateTerrainDoc(addOp(op)(d), { worldHeight: HEIGHT })
    expect(r.ok ? [] : r.errors).toEqual([])
  })
})
