import { describe, expect, it } from 'vitest'
import { builtinOps, type OpDef, type OpImpl } from '@elovox/terrain'
import { dragHandle, handlesOf, heightKey, outlinesOf, resample, translateShape } from '../src/ui/handles/geometry.ts'

const impl = (type: string): OpImpl => builtinOps.get(type)!
const hill: OpDef = { id: 'h', type: 'hills', enabled: true, shape: { kind: 'circle', center: [100, 100], radius: 20, falloff: 10 }, params: { amplitude: 5 } }
const peak: OpDef = { id: 'm', type: 'mountain', enabled: true, shape: { kind: 'circle', center: [100, 100], radius: 20 }, params: { height: 30 } }
const rock: OpDef = { id: 'b', type: 'blob', enabled: true, shape: { kind: 'circle', center: [50, 50], radius: 6 }, params: { y: 40, height: 5 } }
const pond: OpDef = { id: 'p', type: 'lake', enabled: true, shape: { kind: 'polygon', points: [[0, 0], [40, 0], [40, 40]] }, params: { level: 20 } }
const tunnel: OpDef = { id: 'c', type: 'cave', enabled: true, shape: { kind: 'path', width: 8, points: [{ x: 0, z: 0, y: 30 }, { x: 40, z: 0, y: 20 }] }, params: {} }
const ridge: OpDef = { id: 'r', type: 'mountain', enabled: true, shape: { kind: 'path', width: 20, points: [{ x: 0, z: 0 }, { x: 0, z: 40 }] }, params: { height: 30 } }

describe('heightKey', () => {
  it('is y for ops with an anchored y param', () => {
    expect(heightKey(impl('blob'))).toBe('y')
    expect(heightKey(impl('flatten'))).toBe('y')
    expect(heightKey(impl('hills'))).toBeNull()
  })
})

describe('handlesOf', () => {
  it('gives a circle a centre, a rim handle and, for falloff ops, a falloff handle at 45°', () => {
    const hs = handlesOf(hill, impl('hills'))
    expect(hs.map((h) => h.kind)).toEqual(['center', 'radius', 'falloff'])
    expect(hs[1]).toMatchObject({ x: 120, z: 100 })
    expect(hs[2]!.x).toBeCloseTo(100 + 30 * Math.SQRT1_2)
    expect(handlesOf(peak, impl('mountain')).map((h) => h.kind)).toEqual(['center', 'radius'])
  })

  it('puts the height on the centre of a blob', () => {
    expect(handlesOf(rock, impl('blob'))[0]).toEqual({ kind: 'center', index: 0, x: 50, z: 50, y: 40 })
  })

  it('gives a polygon its vertices and an insert handle on every edge, the closing one included', () => {
    const hs = handlesOf(pond, impl('lake'))
    expect(hs.filter((h) => h.kind === 'vertex')).toHaveLength(3)
    expect(hs.filter((h) => h.kind === 'insert').map((h) => [h.index, h.x, h.z])).toEqual([[1, 20, 0], [2, 40, 20], [3, 20, 20]])
  })

  it('gives a path its vertices (with y for volume ops), midpoint inserts and a width handle', () => {
    const hs = handlesOf(tunnel, impl('cave'))
    expect(hs.filter((h) => h.kind === 'vertex').map((h) => h.y)).toEqual([30, 20])
    expect(hs.find((h) => h.kind === 'insert')).toMatchObject({ index: 1, x: 20, z: 0 })
    expect(hs.find((h) => h.kind === 'width')).toMatchObject({ x: 0, z: 4 })
  })
})

describe('outlinesOf', () => {
  it('draws a circle ring and a faint falloff ring', () => {
    const o = outlinesOf(hill)
    expect(o.map((l) => [l.closed, l.faint])).toEqual([[true, false], [true, true]])
    const r = Math.hypot(o[0]!.points[5]![0] - 100, o[0]!.points[5]![1] - 100)
    expect(r).toBeCloseTo(20)
  })

  it('draws a path centre line and two faint side lines per segment', () => {
    const o = outlinesOf(ridge)
    expect(o).toHaveLength(3)
    expect(o[1]!.points).toEqual([[-10, 0], [-10, 40]])
    expect(o[2]!.points).toEqual([[10, 0], [10, 40]])
  })
})

describe('resample', () => {
  it('keeps points at most `step` apart, ending on the last point of an open line', () => {
    expect(resample([[0, 0], [5, 0]], false, 2)).toEqual([[0, 0], [5 / 3, 0], [10 / 3, 0], [5, 0]])
  })

  it('closes a loop without repeating the first point', () => {
    expect(resample([[0, 0], [2, 0], [2, 2]], true, 2)).toHaveLength(4)
  })
})

describe('dragHandle', () => {
  const at = (x: number, z: number, y?: number) => (y === undefined ? { x, z } : { x, z, y })

  it('moves a circle centre, snapped to blocks', () => {
    expect(dragHandle(hill, impl('hills'), handlesOf(hill, impl('hills'))[0]!, at(100, 100), at(130.4, 90.6)).shape).toMatchObject({ center: [130, 91] })
  })

  it('moves a blob up with a height drag, and ignores a height drag on ops without one', () => {
    const c = handlesOf(rock, impl('blob'))[0]!
    expect(dragHandle(rock, impl('blob'), c, at(50, 50, 40), at(50, 50, 52.6)).params.y).toBe(53)
    expect(dragHandle(peak, impl('mountain'), handlesOf(peak, impl('mountain'))[0]!, at(100, 100), at(100, 100, 50))).toBe(peak)
  })

  it('sets the radius and the falloff from the distance to the centre, never below their minimum', () => {
    const [, rim, fall] = handlesOf(hill, impl('hills'))
    expect(dragHandle(hill, impl('hills'), rim!, at(120, 100), at(135, 100)).shape).toMatchObject({ radius: 35 })
    expect(dragHandle(hill, impl('hills'), rim!, at(120, 100), at(100.2, 100)).shape).toMatchObject({ radius: 1 })
    expect(dragHandle(hill, impl('hills'), fall!, at(0, 0), at(140, 100)).shape).toMatchObject({ falloff: 20 })
    expect(dragHandle(hill, impl('hills'), fall!, at(0, 0), at(105, 100)).shape).toMatchObject({ falloff: 0 })
  })

  it('moves polygon and path vertices; a height drag moves a path point in y', () => {
    expect(dragHandle(pond, impl('lake'), { kind: 'vertex', index: 1, x: 40, z: 0 }, at(40, 0), at(50, 5)).shape).toMatchObject({ points: [[0, 0], [50, 5], [40, 40]] })
    const moved = dragHandle(tunnel, impl('cave'), { kind: 'vertex', index: 0, x: 0, z: 0, y: 30 }, at(0, 0, 30), at(0, 0, 12.2))
    expect(moved.shape).toMatchObject({ points: [{ x: 0, z: 0, y: 12 }, { x: 40, z: 0, y: 20 }] })
  })

  it('inserts a vertex where the insert handle is dragged, with an interpolated y on volume paths', () => {
    expect(dragHandle(pond, impl('lake'), { kind: 'insert', index: 3, x: 20, z: 20 }, at(20, 20), at(10, 30)).shape).toMatchObject({ points: [[0, 0], [40, 0], [40, 40], [10, 30]] })
    expect(dragHandle(tunnel, impl('cave'), { kind: 'insert', index: 1, x: 20, z: 0 }, at(20, 0), at(20, 6)).shape).toMatchObject({
      points: [{ x: 0, z: 0, y: 30 }, { x: 20, z: 6, y: 25 }, { x: 40, z: 0, y: 20 }],
    })
  })

  it('sets a path width from twice the distance to the first point, at least 1', () => {
    const w = handlesOf(ridge, impl('mountain')).find((h) => h.kind === 'width')!
    expect(dragHandle(ridge, impl('mountain'), w, at(10, 0), at(15, 0)).shape).toMatchObject({ width: 30 })
    expect(dragHandle(ridge, impl('mountain'), w, at(10, 0), at(0.1, 0)).shape).toMatchObject({ width: 1 })
  })

  it('moves the whole op by the drag distance', () => {
    expect(dragHandle(pond, impl('lake'), 'body', at(10, 10), at(15.4, 7)).shape).toEqual({ kind: 'polygon', points: [[5, -3], [45, -3], [45, 37]] })
    expect(translateShape(ridge.shape, 1, 2)).toMatchObject({ points: [{ x: 1, z: 2 }, { x: 1, z: 42 }] })
  })
})
