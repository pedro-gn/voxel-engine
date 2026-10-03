import { describe, expect, it } from 'vitest'
import { Check } from '../src/doc/check.ts'
import type { OpDef } from '../src/doc/types.ts'
import { biome } from '../src/ops/biome.ts'
import { flatten } from '../src/ops/flatten.ts'
import { hills } from '../src/ops/hills.ts'
import { mountain } from '../src/ops/mountain.ts'
import { plateau, terrace } from '../src/ops/plateau.ts'
import type { Cell, CompileContext, HeightOpImpl } from '../src/ops/registry.ts'

const ctx: CompileContext = { seed: 7, height: 128, seaLevel: 10, biomeIndex: (n) => ['plain', 'mesa'].indexOf(n) }
const cell = (h = 40): Cell => ({ h, water: -1, wet: -Infinity, biome: -1 })
function run(impl: HeightOpImpl, def: Omit<OpDef, 'type' | 'enabled'>, x: number, z: number, h = 40): Cell {
  const c = cell(h)
  impl.compile({ ...def, type: impl.type, enabled: true }, ctx).apply(x, z, c)
  return c
}
function errors(impl: HeightOpImpl, params: Record<string, unknown>): string[] {
  const c = new Check()
  impl.validate(c, 'ops[0]', { id: 'a', type: impl.type, enabled: true, shape: { kind: 'circle', center: [0, 0], radius: 5 }, params }, { biomes: ['plain', 'mesa'], height: 128 })
  return c.errors
}
const disc = (radius: number, falloff = 0) => ({ kind: 'circle' as const, center: [100, 100] as [number, number], radius, falloff })

describe('hills', () => {
  it('adds offset + amplitude * noise inside, fading over the falloff', () => {
    const def = { id: 'h', shape: disc(20, 10), params: { amplitude: 0, offset: 6 } }
    expect(run(hills, def, 100, 100).h).toBe(46)
    expect(run(hills, def, 125, 100).h).toBeCloseTo(43, 5) // 5 of 10 blocks into the falloff
    expect(run(hills, def, 140, 100).h).toBe(40)
  })
  it('lowers an area with blend min (a sea floor)', () => {
    expect(run(hills, { id: 'h', shape: disc(20), params: { amplitude: 0, offset: 12 }, blend: 'min' }, 100, 100).h).toBe(12)
  })
  it('validates params', () => {
    expect(errors(hills, { amplitude: -1, noise: { scale: 0 } })).toEqual(['ops[0].params.amplitude: must be >= 0', 'ops[0].params.noise.scale: must be > 0'])
  })
})

describe('mountain', () => {
  it('peaks at the centre and vanishes at the edge', () => {
    const def = { id: 'm', shape: disc(50), params: { height: 60, roughness: 0 } }
    expect(run(mountain, def, 100, 100).h).toBe(100)
    expect(run(mountain, def, 125, 100).h).toBe(70) // smoothstep(0.5) = 0.5
    expect(run(mountain, def, 150, 100).h).toBe(40)
  })
  it('roughness modulates height with ridged noise, never above the full height', () => {
    const def = { id: 'm', shape: disc(50), params: { height: 60, roughness: 1 } }
    const hs = [0, 3, 6, 9, 12].map((d) => run(mountain, def, 100 + d, 100).h)
    for (const h of hs) { expect(h).toBeGreaterThanOrEqual(40); expect(h).toBeLessThanOrEqual(100) }
    expect(new Set(hs).size).toBeGreaterThan(1)
  })
  it('follows a path as a range', () => {
    const def = { id: 'r', shape: { kind: 'path' as const, width: 40, points: [{ x: 0, z: 0 }, { x: 200, z: 0 }] }, params: { height: 50, roughness: 0, profile: 'linear' } }
    expect(run(mountain, def, 120, 0).h).toBe(90)
    expect(run(mountain, def, 120, 10).h).toBe(65)
  })
})

describe('plateau', () => {
  it('terrace() rises from 0 to 1 in flat steps', () => {
    expect(terrace(0, 3)).toBe(0)
    expect(terrace(1, 3)).toBe(1)
    expect(terrace(0.4, 3)).toBeCloseTo(1 / 3, 10) // on the first tread
    expect(terrace(0.5, 0)).toBe(0.5)
  })
  it('raises a mesa with a wall `wall` blocks wide and leaves outside ground alone', () => {
    const def = { id: 'p', shape: disc(30), params: { top: 80, base: 40, wall: 10 } }
    expect(run(plateau, def, 100, 100).h).toBe(80)
    expect(run(plateau, def, 125, 100).h).toBe(60) // 5 of 10 wall blocks in
    expect(run(plateau, def, 135, 100, 20).h).toBe(20) // outside: low ground is not raised
    expect(run(plateau, def, 100, 100, 90).h).toBe(90) // blend max: higher ground wins
  })
  it('validates top and base against the world height', () => {
    expect(errors(plateau, { top: 200, base: 10, terraces: 1.5 })).toEqual(['ops[0].params.top: must be <= 128', 'ops[0].params.terraces: must be an integer'])
  })
})

describe('flatten', () => {
  it('sets the height inside and blends over the falloff', () => {
    const def = { id: 'f', shape: disc(10, 10), params: { y: 50 } }
    expect(run(flatten, def, 100, 100).h).toBe(50)
    expect(run(flatten, def, 115, 100).h).toBe(45)
    expect(run(flatten, def, 121, 100).h).toBe(40)
  })
})

describe('biome', () => {
  it('sets the biome index where the weight is >= 0.5', () => {
    const def = { id: 'b', shape: disc(10, 10), params: { biome: 'mesa' } }
    expect(run(biome, def, 100, 100).biome).toBe(1)
    expect(run(biome, def, 114, 100).biome).toBe(1)
    expect(run(biome, def, 116, 100).biome).toBe(-1)
    expect(run(biome, def, 100, 100).h).toBe(40)
  })
  it('jitters its border with noise', () => {
    const def = { id: 'b', shape: { kind: 'polygon' as const, points: [[0, 0], [200, 0], [200, 200], [0, 200]] as [number, number][] }, params: { biome: 'mesa', jitter: 12 } }
    const along = Array.from({ length: 60 }, (_, i) => run(biome, def, i * 3, 2).biome) // 2 blocks inside the top edge
    expect(along).toContain(1)
    expect(along).toContain(-1)
  })
  it('rejects unknown biomes', () => {
    expect(errors(biome, { biome: 'swamp' })).toEqual(['ops[0].params.biome: must be one of plain, mesa'])
  })
})
