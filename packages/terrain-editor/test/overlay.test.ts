import { describe, expect, it } from 'vitest'
import { builtinOps, type OpDef } from '@elovox/terrain'
import { LIFT, Overlay, groundSampler, type DrawOp } from '../src/ui/handles/overlay.ts'

const hill: OpDef = { id: 'h', type: 'hills', enabled: true, shape: { kind: 'circle', center: [100, 100], radius: 20, falloff: 10 }, params: { amplitude: 5 } }
const rock: OpDef = { id: 'b', type: 'blob', enabled: true, shape: { kind: 'circle', center: [50, 50], radius: 6 }, params: { y: 40, height: 5 } }
const op = (def: OpDef, selected = false, failed = false): DrawOp => ({ def, impl: builtinOps.get(def.type)!, selected, failed })

describe('groundSampler', () => {
  // Stone up to y 19, a leaf at y 25 over x 3: the leaf is skipped.
  const get = (x: number, y: number) => (y < 20 ? 1 : x === 3 && y === 25 ? 7 : 0)
  const ground = groundSampler(get, new Set([7]), 64, [16, 16])

  it('is the y above the top voxel, skipping tree blocks', () => {
    expect(ground(2, 2)).toBe(20)
    expect(ground(3.7, 2)).toBe(20)
  })

  it('clamps coordinates into the world', () => {
    expect(ground(-5, 99)).toBe(20)
  })

  it('is 0 for an empty column', () => {
    expect(groundSampler(() => 0, new Set(), 64, [16, 16])(1, 1)).toBe(0)
  })
})

describe('Overlay', () => {
  it('draws the selected op with its handles on the ground', () => {
    const o = new Overlay(() => 30)
    o.draw([op(hill, true), op(rock)], false)
    expect(o.handles.map((h) => h.handle.kind)).toEqual(['center', 'radius', 'falloff'])
    expect(o.handles[0]!.pos.toArray()).toEqual([100, 30 + LIFT, 100])
    expect(o.outlines.map((l) => l.id)).toEqual(['h']) // the falloff ring is faint, not pickable
    expect(o.group.children.length).toBe(2 + 3) // ring, falloff ring, three markers
    o.dispose()
  })

  it('places a height handle at its own y', () => {
    const o = new Overlay(() => 30)
    o.draw([op(rock, true)], false)
    expect(o.handles[0]!.pos.y).toBe(40 + LIFT)
    o.dispose()
  })

  it('shows unselected ops only with showAll, and failed ops always', () => {
    const o = new Overlay(() => 30)
    o.draw([op(hill), op(rock, false, true)], false)
    expect(o.outlines.map((l) => l.id)).toEqual(['b'])
    o.draw([op(hill), op(rock)], true)
    expect(o.outlines.map((l) => l.id)).toEqual(['h', 'b'])
    expect(o.handles).toEqual([])
    o.dispose()
  })
})
