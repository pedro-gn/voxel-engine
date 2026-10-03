import { describe, expect, it } from 'vitest'
import { Check } from '../src/doc/check.ts'
import type { OpDef } from '../src/doc/types.ts'
import type { CompileContext, VolumeOpImpl } from '../src/ops/registry.ts'
import { archCurve, compileTube } from '../src/ops/tube.ts'
import { arch, blob, cave, overhang } from '../src/ops/volume.ts'

const ctx: CompileContext = { seed: 3, height: 128, seaLevel: 10, biomeIndex: () => 0 }
function compile(impl: VolumeOpImpl, def: Omit<OpDef, 'type' | 'enabled'>) {
  return impl.compile({ ...def, type: impl.type, enabled: true }, ctx)
}

describe('compileTube', () => {
  const tube = compileTube([{ x: 0, y: 50, z: 0, hw: 4, hh: 2 }, { x: 40, y: 50, z: 0, hw: 4, hh: 2 }], 0)
  it('is positive inside the elliptical section, 0 on the wall, negative outside', () => {
    expect(tube.field(20, 50, 0)).toBe(2)
    expect(tube.field(20, 50, 4)).toBe(0)
    expect(tube.field(20, 52, 0)).toBe(0)
    expect(tube.field(20, 50, 8)).toBeLessThan(0)
  })
  it('bounds the tube with its radii', () => {
    expect(tube.bounds).toEqual({ x0: -4, x1: 44, y0: 48, y1: 52, z0: -4, z1: 4 })
  })
  it('archCurve peaks `rise` above the endpoints', () => {
    const pts = archCurve({ x: 0, y: 10, z: 0, hw: 2, hh: 2 }, { x: 20, y: 10, z: 0, hw: 2, hh: 2 }, 8, 24)
    expect(pts).toHaveLength(25)
    expect(pts[12]).toEqual({ x: 10, y: 18, z: 0, hw: 2, hh: 2 })
  })
})

describe('arch', () => {
  const op = compile(arch, {
    id: 'a', shape: { kind: 'path', width: 4, points: [{ x: 0, z: 0, y: 40 }, { x: 30, z: 0, y: 40 }] }, params: { rise: 12, wobble: 0 },
  })
  it('adds solid along the curve and leaves the space under it open', () => {
    expect(op.mode).toBe('add')
    expect(op.density(15, 52, 0)).toBeGreaterThan(1) // the keystone
    expect(op.density(15, 44, 0)).toBeLessThan(0) // under the arch
  })
  it('requires exactly two points with y', () => {
    const c = new Check()
    arch.validate(c, 'ops[0]', { id: 'a', type: 'arch', enabled: true, shape: { kind: 'path', width: 4, points: [{ x: 0, z: 0, y: 1 }, { x: 1, z: 0, y: 1 }, { x: 2, z: 0, y: 1 }] }, params: {} }, { biomes: [], height: 128 })
    expect(c.errors).toEqual(['ops[0].shape.points: an arch takes exactly 2 points', 'ops[0].params.rise: is required'])
  })
})

describe('cave and overhang', () => {
  it('cave carves a round tunnel', () => {
    const op = compile(cave, { id: 'c', shape: { kind: 'path', width: 6, points: [{ x: 0, z: 0, y: 30 }, { x: 0, z: 40, y: 20 }] }, params: { wobble: 0 } })
    expect(op.mode).toBe('carve')
    expect(op.density(0, 25, 20)).toBe(3)
  })
  it('overhang is flat: a third as tall as it is wide by default', () => {
    const op = compile(overhang, { id: 'o', shape: { kind: 'path', width: 12, points: [{ x: 0, z: 0, y: 30 }, { x: 40, z: 0, y: 30 }] }, params: { wobble: 0 } })
    expect(op.density(20, 30, 5.9)).toBeGreaterThan(0)
    expect(op.density(20, 32.1, 0)).toBeLessThan(0)
  })
})

describe('blob', () => {
  const op = compile(blob, { id: 'b', shape: { kind: 'circle', center: [100, 100], radius: 10 }, params: { y: 90, height: 4, wobble: 0 } })
  it('is an ellipsoid at y with vertical radius `height`', () => {
    expect(op.density(100, 90, 100)).toBe(4)
    expect(op.density(110, 90, 100)).toBe(0)
    expect(op.density(100, 94, 100)).toBe(0)
    expect(op.bounds).toEqual({ x0: 90, x1: 110, y0: 86, y1: 94, z0: 90, z1: 110 })
  })
  it('wobbles with noise and pads its bounds by the wobble', () => {
    const w = compile(blob, { id: 'b', shape: { kind: 'circle', center: [100, 100], radius: 10 }, params: { y: 90, height: 4, mode: 'carve' } })
    expect(w.mode).toBe('carve')
    expect(w.bounds.x0).toBe(88)
    let differs = false
    for (let i = 0; i < 10; i++) if (w.density(95 + i, 90, 100) !== op.density(95 + i, 90, 100)) differs = true
    expect(differs).toBe(true)
  })
})
