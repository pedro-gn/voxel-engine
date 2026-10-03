import { describe, expect, it } from 'vitest'
import type { OpDef } from '@elovox/terrain'
import {
  addOp, insertVertex, moveVertex, removeOp, removeVertex, reorderOp, replaceOp, setBase, setBlend, setEnabled, setParam, setSeaLevel, setShape,
} from '../src/core/edits.ts'
import { deepFreeze, doc } from './fixtures.ts'

const frozen = () => deepFreeze(doc())
const ids = (d: { ops: OpDef[] }) => d.ops.map((o) => o.id)
const extra: OpDef = { id: 'flat', type: 'flatten', enabled: true, shape: { kind: 'circle', center: [30, 30], radius: 8 }, params: { y: 30 } }

describe('document edits', () => {
  it('add an op at the end or at an index, sharing the other ops', () => {
    const d = frozen()
    const a = addOp(extra)(d)
    expect(ids(a)).toEqual(['hill', 'ridge', 'pond', 'rock', 'flat'])
    expect(a.ops[0]).toBe(d.ops[0])
    expect(ids(addOp(extra, 1)(d))).toEqual(['hill', 'flat', 'ridge', 'pond', 'rock'])
  })

  it('remove and replace an op; an unknown id throws', () => {
    const d = frozen()
    expect(ids(removeOp('ridge')(d))).toEqual(['hill', 'pond', 'rock'])
    const r = replaceOp('pond', { ...extra, id: 'pond' })(d)
    expect(r.ops[2]!.type).toBe('flatten')
    expect(r.ops[1]).toBe(d.ops[1])
    expect(() => removeOp('nope')(d)).toThrow('no op "nope"')
  })

  it('toggle enabled', () => {
    expect(setEnabled('hill', false)(frozen()).ops[0]!.enabled).toBe(false)
  })

  it('reorder by a delta, clamped to the list, and return the same document when nothing moves', () => {
    const d = frozen()
    expect(ids(reorderOp('ridge', 1)(d))).toEqual(['hill', 'pond', 'ridge', 'rock'])
    expect(ids(reorderOp('ridge', -5)(d))).toEqual(['ridge', 'hill', 'pond', 'rock'])
    expect(reorderOp('hill', -1)(d)).toBe(d)
  })

  it('set and delete a param', () => {
    const d = frozen()
    expect(setParam('hill', 'offset', 3)(d).ops[0]!.params).toEqual({ amplitude: 10, offset: 3 })
    expect(setParam('hill', 'amplitude', undefined)(d).ops[0]!.params).toEqual({})
  })

  it('set and clear the blend', () => {
    const d = frozen()
    const a = setBlend('hill', 'max')(d)
    expect(a.ops[0]!.blend).toBe('max')
    expect('blend' in setBlend('hill', undefined)(a).ops[0]!).toBe(false)
  })

  it('replace a shape', () => {
    const shape = { kind: 'circle' as const, center: [10, 10] as [number, number], radius: 3 }
    expect(setShape('hill', shape)(frozen()).ops[0]!.shape).toEqual(shape)
  })

  it('move, insert and remove vertices of polygons and paths', () => {
    const d = frozen()
    const moved = moveVertex('pond', 0, [90, 170])(d)
    expect(moved.ops[2]!.shape).toMatchObject({ points: [[90, 170], [140, 180], [140, 220], [100, 220]] })
    const inserted = insertVertex('ridge', 1, { x: 170, z: 70 })(d)
    expect(inserted.ops[1]!.shape).toMatchObject({ points: [{ x: 150, z: 40 }, { x: 170, z: 70 }, { x: 200, z: 90 }] })
    expect(removeVertex('pond', 3)(d).ops[2]!.shape).toMatchObject({ points: [[100, 180], [140, 180], [140, 220]] })
    expect(() => moveVertex('hill', 0, [1, 1])(d)).toThrow('a circle has no vertices')
  })

  it('set the sea level and the base fill', () => {
    const d = frozen()
    expect(setSeaLevel(14)(d).seaLevel).toBe(14)
    const base = { ...d.base, amplitude: 9 }
    const b = setBase(base)(d)
    expect(b.base).toBe(base)
    expect(b.ops).toBe(d.ops)
  })
})
