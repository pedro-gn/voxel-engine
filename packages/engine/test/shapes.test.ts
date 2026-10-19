import { describe, expect, it } from 'vitest'
import {
  SHAPE, postState, shapeBoxes, slabState, stairForm, stairState, turnShapeState, type Box, type Facing, type StairForm,
} from '../src/blocks/shapes.ts'

const STRAIGHT = { kind: 'straight' } as const
const vol = (bs: readonly Box[]) => bs.reduce((s, [a, b, c, d, e, f]) => s + (d - a) * (e - b) * (f - c), 0)

describe('block shapes', () => {
  it('packs and turns states', () => {
    expect(turnShapeState('stair', stairState(0), 1)).toBe(stairState(1))
    expect(turnShapeState('stair', stairState(3, true), 1)).toBe(stairState(0, true))
    expect(turnShapeState('stair', stairState(1), -1)).toBe(stairState(0))
    expect(turnShapeState('post', postState('x'), 1)).toBe(postState('z'))
    expect(turnShapeState('post', postState('y'), 3)).toBe(postState('y'))
    expect(turnShapeState('slab', slabState(true), 2)).toBe(slabState(true))
  })
  it('gives each shape its volume', () => {
    expect(vol(shapeBoxes(SHAPE.SLAB, slabState(false), STRAIGHT))).toBe(2048)
    expect(vol(shapeBoxes(SHAPE.STAIR, stairState(0), STRAIGHT))).toBe(3072)
    expect(vol(shapeBoxes(SHAPE.STAIR, stairState(0), { kind: 'outer', side: 1 }))).toBe(2560)
    expect(vol(shapeBoxes(SHAPE.STAIR, stairState(0), { kind: 'inner', side: 1 }))).toBe(3584)
    expect(vol(shapeBoxes(SHAPE.POST, postState('y'), STRAIGHT))).toBe(576)
  })
  it('places the parts', () => {
    expect(shapeBoxes(SHAPE.SLAB, slabState(true), STRAIGHT)).toEqual([[0, 8, 0, 16, 16, 16]])
    expect(shapeBoxes(SHAPE.STAIR, stairState(0), STRAIGHT)).toContainEqual([8, 8, 0, 16, 16, 16]) // +x high half
    expect(shapeBoxes(SHAPE.STAIR, stairState(0, true), STRAIGHT)).toContainEqual([8, 0, 0, 16, 8, 16]) // mirrored
    expect(shapeBoxes(SHAPE.STAIR, stairState(0), { kind: 'outer', side: 1 })).toContainEqual([8, 8, 8, 16, 16, 16])
    expect(shapeBoxes(SHAPE.POST, postState('x'), STRAIGHT)).toEqual([[0, 5, 5, 16, 11, 11]])
  })
  it('derives corners like a hip roof', () => {
    // corner (0,0) of a ring facing inward: itself +z, the cell on its high side (+z) faces +x
    const ring = (dx: number, dz: number) => (dx === 0 && dz === 1 ? stairState(0) : dx === 1 && dz === 0 ? stairState(1) : -1)
    expect(stairForm(stairState(1), ring)).toEqual({ kind: 'outer', side: 0 })
    expect(stairForm(stairState(1), (dx, dz) => (dx === 0 && dz === -1 ? stairState(0) : -1))).toEqual({ kind: 'inner', side: 0 })
    expect(stairForm(stairState(1), (dx, dz) => (dx === 0 && dz === 1 ? stairState(0, true) : -1))).toEqual(STRAIGHT) // other half
    expect(stairForm(stairState(1), (dx, dz) => (dx === 0 && dz === 1 ? stairState(1) : -1))).toEqual(STRAIGHT) // parallel
  })

  const cases: [Facing, boolean, StairForm][] = []
  for (const f of [0, 1, 2, 3] as const) {
    for (const up of [false, true]) {
      const side = ((f + 1) & 3) as Facing
      cases.push([f, up, STRAIGHT], [f, up, { kind: 'outer', side }], [f, up, { kind: 'inner', side }])
    }
  }
  it.each(cases)('keeps facing %i (upside down %s, %o) inside the cell with no overlap', (f, up, form) => {
    const bs = shapeBoxes(SHAPE.STAIR, stairState(f, up), form)
    for (const [x0, y0, z0, x1, y1, z1] of bs) {
      for (const v of [x0, y0, z0, x1, y1, z1]) expect(v >= 0 && v <= 16).toBe(true)
      expect(x0 < x1 && y0 < y1 && z0 < z1).toBe(true)
    }
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i]!, b = bs[j]!
        const overlap = a[0] < b[3] && b[0] < a[3] && a[1] < b[4] && b[1] < a[4] && a[2] < b[5] && b[2] < a[5]
        expect(overlap).toBe(false)
      }
    }
    expect(vol(bs)).toBe(form.kind === 'straight' ? 3072 : form.kind === 'outer' ? 2560 : 3584)
  })
})

describe('shapes in the public API', () => {
  it('exports the shape helpers from both entries', async () => {
    const client = await import('../src/index.ts')
    const sim = await import('../src/sim/runSimWorker.ts')
    for (const entry of [client, sim] as Record<string, unknown>[]) {
      for (const name of ['slabState', 'stairState', 'postState', 'turnShapeState']) expect(typeof entry[name]).toBe('function')
    }
    type Exported = [import('../src/index.ts').BlockShape, import('../src/index.ts').Facing, import('../src/index.ts').PostAxis,
      import('../src/sim/runSimWorker.ts').BlockShape, import('../src/sim/runSimWorker.ts').Facing, import('../src/sim/runSimWorker.ts').PostAxis]
    const sample: Exported = ['stair', 3, 'x', 'post', 0, 'z']
    expect(sample).toHaveLength(6)
  })
})
