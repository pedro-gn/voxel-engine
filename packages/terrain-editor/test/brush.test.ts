import { describe, expect, it } from 'vitest'
import { DabSpacer, brushWeight, clampSettings, dabSpacing, type Point3 } from '../src/core/brush.ts'

describe('brushWeight', () => {
  it('is the strength inside the core, fades to 0 at the radius, and is 0 past it', () => {
    const hard = { radius: 10, strength: 0.8, falloff: 0 }
    expect(brushWeight(0, hard)).toBe(0.8)
    expect(brushWeight(10, hard)).toBe(0.8)
    expect(brushWeight(10.01, hard)).toBe(0)
    const soft = { radius: 10, strength: 1, falloff: 1 }
    expect(brushWeight(0, soft)).toBe(1)
    expect(brushWeight(5, soft)).toBeCloseTo(0.5)
    expect(brushWeight(10, soft)).toBe(0)
    const half = { radius: 10, strength: 1, falloff: 0.5 }
    expect(brushWeight(4, half)).toBe(1)
    expect(brushWeight(7.5, half)).toBeCloseTo(0.5)
  })
})

describe('clampSettings', () => {
  it('keeps every field in range', () => {
    expect(clampSettings({ radius: 999, strength: -1, falloff: 3 })).toEqual({ radius: 64, strength: 0, falloff: 1 })
    expect(clampSettings({ radius: 0.5, strength: 0.4, falloff: 0.2 })).toEqual({ radius: 2, strength: 0.4, falloff: 0.2 })
  })
})

describe('DabSpacer', () => {
  const xs = (ps: Point3[]) => ps.map((p) => Math.round(p.x * 1000) / 1000)

  it('dabs at the first point, then every `spacing` blocks', () => {
    const s = new DabSpacer(2)
    expect(xs(s.to({ x: 0, y: 0, z: 0 }))).toEqual([0])
    expect(xs(s.to({ x: 10, y: 0, z: 0 }))).toEqual([2, 4, 6, 8, 10])
  })

  it('does not depend on how the drag is split into pointer events', () => {
    const one = new DabSpacer(2), many = new DabSpacer(2)
    const a = [...one.to({ x: 0, y: 0, z: 0 }), ...one.to({ x: 9, y: 0, z: 0 })]
    const b: Point3[] = []
    for (let i = 0; i <= 18; i++) b.push(...many.to({ x: i / 2, y: 0, z: 0 }))
    expect(xs(b)).toEqual(xs(a))
  })

  it('spaces dabs in 3D', () => {
    const s = new DabSpacer(5)
    s.to({ x: 0, y: 0, z: 0 })
    expect(s.to({ x: 3, y: 4, z: 0 })).toEqual([{ x: 3, y: 4, z: 0 }])
  })

  it('spaces dabs a quarter radius apart, at least one block', () => {
    expect(dabSpacing(16)).toBe(4)
    expect(dabSpacing(2)).toBe(1)
  })
})
