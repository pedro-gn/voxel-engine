import { describe, expect, it } from 'vitest'
import { Check } from '../src/doc/check.ts'
import { blend } from '../src/shapes/blend.ts'
import { PROFILES, profile } from '../src/shapes/profile.ts'
import { checkShape, compileShape, newSample, weight } from '../src/shapes/shape.ts'

const s = newSample()

describe('circle', () => {
  const c = compileShape({ kind: 'circle', center: [10, 20], radius: 5, falloff: 4 })
  it('reports distance, edge and bounds', () => {
    c.sample(10, 20, s)
    expect([s.dist, s.edge, s.width]).toEqual([-5, 0, 10])
    c.sample(13, 24, s) // 5 away: on the edge
    expect([s.dist, s.edge]).toEqual([0, 1])
    expect(c.bounds).toEqual({ x0: 5, z0: 15, x1: 15, z1: 25 })
  })
  it('weights 1 inside, fades over the falloff, 0 beyond', () => {
    c.sample(10, 20, s); expect(weight(s, c.falloff)).toBe(1)
    c.sample(17, 20, s); expect(weight(s, c.falloff)).toBeCloseTo(0.5, 5) // 2 of 4 blocks out
    c.sample(19, 20, s); expect(weight(s, c.falloff)).toBe(0)
  })
})

describe('polygon', () => {
  const square = compileShape({ kind: 'polygon', points: [[0, 0], [40, 0], [40, 40], [0, 40]], inset: 10 })
  it('is negative inside, positive outside, with a signed distance to the nearest edge', () => {
    square.sample(20, 20, s); expect(s.dist).toBe(-20); expect(s.edge).toBe(0)
    square.sample(35, 20, s); expect(s.dist).toBe(-5); expect(s.edge).toBe(0.5)
    square.sample(45, 20, s); expect(s.dist).toBe(5); expect(s.edge).toBe(1.5)
    expect(square.bounds).toEqual({ x0: 0, z0: 0, x1: 40, z1: 40 })
  })
  it('handles a concave polygon', () => {
    const l = compileShape({ kind: 'polygon', points: [[0, 0], [30, 0], [30, 10], [10, 10], [10, 30], [0, 30]] })
    l.sample(20, 20, s); expect(s.dist).toBeGreaterThan(0) // in the notch
    l.sample(5, 20, s); expect(s.dist).toBeLessThan(0)
  })
})

describe('path', () => {
  const p = compileShape({ kind: 'path', width: 10, points: [{ x: 0, z: 0, y: 10 }, { x: 100, z: 0, y: 30, width: 20 }] })
  it('measures distance to the polyline with interpolated width, y and along', () => {
    p.sample(50, 3, s)
    expect(s.along).toBe(0.5)
    expect(s.y).toBe(20)
    expect(s.width).toBe(15)
    expect(s.dist).toBe(3 - 7.5)
    expect(s.edge).toBeCloseTo(3 / 7.5, 10)
  })
  it('clamps to the end points', () => {
    p.sample(-10, 0, s)
    expect(s.along).toBe(0)
    expect(s.dist).toBe(10 - 5)
  })
  it('pads bounds by the widest half-width', () => {
    expect(p.bounds).toEqual({ x0: -10, z0: -10, x1: 110, z1: 10 })
  })
})

describe('profiles', () => {
  it.each(PROFILES)('%s is 1-ish at the centre, 0 at and beyond the edge, never negative', (name) => {
    expect(profile(name, 0)).toBe(1)
    expect(profile(name, 1)).toBe(0)
    expect(profile(name, 2)).toBe(0)
    for (let e = 0; e < 1; e += 0.05) expect(profile(name, e)).toBeGreaterThanOrEqual(0)
  })
  it('has the expected shapes', () => {
    expect(profile('linear', 0.5)).toBe(0.5)
    expect(profile('round', 0.6)).toBeCloseTo(0.8, 10)
    expect(profile('box', 0.5)).toBe(1)
    expect(profile('flat', 0.99)).toBe(1)
  })
})

describe('blend', () => {
  it('combines heights per mode', () => {
    expect(blend('add', 10, 4, 0.5)).toBe(12)
    expect(blend('carve', 10, 4, 0.5)).toBe(8)
    expect(blend('max', 10, 20, 0.5)).toBe(15)
    expect(blend('max', 10, 5, 1)).toBe(10)
    expect(blend('min', 10, 4, 0.5)).toBe(7)
    expect(blend('min', 10, 40, 1)).toBe(10)
    expect(blend('set', 10, 40, 0.25)).toBe(17.5)
  })
})

describe('checkShape', () => {
  it('reports bad shapes with paths', () => {
    const c = new Check()
    checkShape(c, 'ops[0].shape', { kind: 'path', width: 0, points: [{ x: 1, z: 2 }] })
    checkShape(c, 'ops[1].shape', { kind: 'circle', center: [1], radius: -1 })
    checkShape(c, 'ops[2].shape', { kind: 'blob' })
    checkShape(c, 'ops[3].shape', { kind: 'path', width: 4, points: [{ x: 0, z: 0 }, { x: 1, z: 1 }] }, ['path'], true)
    checkShape(c, 'ops[4].shape', { kind: 'circle', center: [0, 0], radius: 3 }, ['path'])
    expect(c.errors).toEqual([
      'ops[0].shape.width: must be > 0',
      'ops[0].shape.points: must have at least 2 items',
      'ops[1].shape.center: must be [x, z]',
      'ops[1].shape.radius: must be > 0',
      'ops[2].shape.kind: must be one of circle, polygon, path',
      'ops[3].shape.points[0].y: is required',
      'ops[3].shape.points[1].y: is required',
      'ops[4].shape.kind: must be one of path',
    ])
  })
  it('accepts valid shapes', () => {
    const c = new Check()
    expect(checkShape(c, 's', { kind: 'polygon', points: [[0, 0], [1, 0], [0, 1]], falloff: 4 })).toBe(true)
    expect(c.errors).toEqual([])
  })
})
