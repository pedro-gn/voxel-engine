import { describe, expect, it } from 'vitest'
import { Check } from '../src/doc/check.ts'
import type { OpDef } from '../src/doc/types.ts'
import { lake } from '../src/ops/lake.ts'
import type { Cell, CompileContext, HeightOpImpl } from '../src/ops/registry.ts'
import { river } from '../src/ops/river.ts'
import { valley } from '../src/ops/valley.ts'

const ctx: CompileContext = { seed: 7, height: 128, seaLevel: 10, biomeIndex: () => 0 }
function run(impl: HeightOpImpl, def: Omit<OpDef, 'type' | 'enabled'>, x: number, z: number, h = 40): Cell {
  const c: Cell = { h, water: -1, wet: -Infinity, biome: -1 }
  impl.compile({ ...def, type: impl.type, enabled: true }, ctx).apply(x, z, c)
  return c
}
const straight = (width: number) => ({ kind: 'path' as const, width, points: [{ x: 0, z: 0 }, { x: 100, z: 0 }] })

describe('valley', () => {
  it('carves a U across the path, deepest on the axis', () => {
    const def = { id: 'v', shape: straight(20), params: { depth: 10 } }
    expect(run(valley, def, 50, 0).h).toBe(30)
    expect(run(valley, def, 50, 6).h).toBeCloseTo(32, 10) // round(0.6) = 0.8
    expect(run(valley, def, 50, 10).h).toBe(40)
  })
  it('makes a canyon with the box profile', () => {
    const def = { id: 'v', shape: straight(20), params: { depth: 30, profile: 'box' } }
    expect(run(valley, def, 50, 7).h).toBe(10)
    expect(run(valley, def, 50, 9.5).h).toBeGreaterThan(10)
  })
})

describe('river', () => {
  const def = { id: 'r', shape: straight(8), params: { start: 30, end: 20, depth: 2, bank: 10, bankSlope: 0.5 } }
  it('steps the water level down along the path in whole blocks', () => {
    expect(run(river, def, 0, 0).water).toBe(30)
    expect(run(river, def, 55, 0).water).toBe(24) // 30 - 5.5 floored
    expect(run(river, def, 100, 0).water).toBe(20)
  })
  it('cuts a bed below the water and banks that climb outward', () => {
    expect(run(river, def, 50, 0).h).toBe(25 - 1 - 2)
    const edge = run(river, def, 50, 4)
    expect(edge.h).toBe(24) // level - 1 at the channel edge: one block of water
    expect(edge.water).toBe(25)
    const bank = run(river, def, 50, 8)
    expect(bank.h).toBe(27) // the bank starts at the water level, then climbs 4 blocks at slope 0.5
    expect(bank.water).toBe(-1)
    expect(bank.wet).toBe(25)
  })
  it('fades the banks back into high ground instead of leaving a step', () => {
    const at = (z: number) => run(river, def, 50, z, 60).h
    expect(at(8)).toBe(27) // inner half of the bank: full cut
    expect(at(11.5)).toBeGreaterThan(at(10))
    expect(at(14)).toBe(60) // bank edge: back to the ground
    for (let z = 9; z < 14; z += 0.5) expect(at(z + 0.5) - at(z)).toBeLessThan(12) // no cliff
  })
  it('leaves low ground alone and stops past the bank', () => {
    expect(run(river, def, 50, 8, 20).h).toBe(20)
    const far = run(river, def, 50, 15)
    expect([far.h, far.wet]).toEqual([40, -Infinity])
  })
  it('validates levels', () => {
    const c = new Check()
    river.validate(c, 'ops[0]', { id: 'r', type: 'river', enabled: true, shape: straight(4), params: { start: 0 } }, { biomes: [], height: 128 })
    expect(c.errors).toEqual(['ops[0].params.start: must be >= 1', 'ops[0].params.end: is required'])
  })
})

describe('lake', () => {
  const def = { id: 'l', shape: { kind: 'circle' as const, center: [0, 0] as [number, number], radius: 20 }, params: { level: 30, depth: 5, shore: 10, shoreSlope: 0.5 } }
  it('fills a basin with water to its level', () => {
    const mid = run(lake, def, 0, 0)
    expect(mid.h).toBe(24)
    expect(mid.water).toBe(30)
    const rim = run(lake, def, 19, 0)
    expect(rim.h).toBe(30 - 1 - 1.5)
  })
  it('shapes a shore that rises outside the shape', () => {
    const shore = run(lake, def, 24, 0)
    expect(shore.h).toBe(32) // the shore starts at the water level
    expect(shore.water).toBe(-1)
    expect(shore.wet).toBe(30)
    expect(run(lake, def, 31, 0).wet).toBe(-Infinity)
  })
})
