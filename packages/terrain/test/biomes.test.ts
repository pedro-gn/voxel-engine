import { describe, expect, it } from 'vitest'
import { compileBiome, compileBiomeRule, surfaceBlock, type SurfaceInput } from '../src/biomes/biomes.ts'
import { IDS, idOf } from './fixtures.ts'

const at = (o: Partial<SurfaceInput>): SurfaceInput => ({ depth: 0, slope: 0, y: 40, underwater: false, wetRef: 10, ceiling: false, ...o })

describe('surfaceBlock', () => {
  const temperate = compileBiome({
    name: 'temperate',
    surface: [
      { block: 'stone', slope: [1.5, 99] },
      { block: 'gravel', underwater: true, depth: [0, 1] },
      { block: 'sand', nearWater: 2, depth: [0, 2] },
      { block: 'snow', y: [90, 999] },
      { block: 'stone', ceiling: true, depth: [0, 9] },
      { block: 'grass' },
      { block: 'dirt', depth: [1, 3] },
    ],
  }, idOf)
  it('picks the first matching rule', () => {
    expect(surfaceBlock(temperate, IDS.stone!, at({}))).toBe(IDS.grass)
    expect(surfaceBlock(temperate, IDS.stone!, at({ depth: 2 }))).toBe(IDS.dirt)
    expect(surfaceBlock(temperate, IDS.stone!, at({ slope: 2 }))).toBe(IDS.stone)
    expect(surfaceBlock(temperate, IDS.stone!, at({ underwater: true }))).toBe(IDS.gravel)
    expect(surfaceBlock(temperate, IDS.stone!, at({ y: 12 }))).toBe(IDS.sand)
    expect(surfaceBlock(temperate, IDS.stone!, at({ y: 13 }))).toBe(IDS.grass)
    expect(surfaceBlock(temperate, IDS.stone!, at({ y: 95 }))).toBe(IDS.snow)
    expect(surfaceBlock(temperate, IDS.stone!, at({ ceiling: true, depth: 5 }))).toBe(IDS.stone)
  })
  it('falls back to fill below every rule', () => {
    expect(temperate.maxDepth).toBe(9)
    expect(surfaceBlock(temperate, IDS.rock!, at({ depth: 4 }))).toBe(IDS.rock)
    expect(surfaceBlock(temperate, IDS.rock!, at({ depth: 50 }))).toBe(IDS.rock)
  })
  it('stacks bands by y', () => {
    const mesa = compileBiome({ name: 'mesa', surface: [{ bands: { blocks: ['sandstone', 'sandstone_red'], thickness: 3 }, depth: [0, 4] }] }, idOf)
    expect([0, 2, 3, 5, 6].map((y) => surfaceBlock(mesa, 0, at({ y })))).toEqual([IDS.sandstone, IDS.sandstone, IDS.sandstone_red, IDS.sandstone_red, IDS.sandstone])
  })
  it('compiles trees and rocks, with trees on grass by default', () => {
    const b = compileBiome({ name: 'f', surface: [], trees: { density: 0.2, kinds: ['pine'] }, rocks: { density: 0.05, size: [1, 3] } }, idOf)
    expect(b.trees?.on.has(IDS.grass!)).toBe(true)
    expect(b.rocks?.size).toEqual([1, 3])
  })
})

describe('compileBiomeRule', () => {
  const names = ['plain', 'alpine', 'wet']
  const index = (n: string) => names.indexOf(n)
  it('uses the first matching height rule, else the default', () => {
    const rule = compileBiomeRule({ default: 'plain', rules: [{ biome: 'alpine', minHeight: 90 }] }, index, 1)
    expect(rule(0, 0, 50)).toBe(0)
    expect(rule(0, 0, 95)).toBe(1)
  })
  it('reads moisture noise for moisture ranges', () => {
    const rule = compileBiomeRule({ default: 'plain', moisture: { scale: 8 }, rules: [{ biome: 'wet', moisture: [0.5, 1] }] }, index, 1)
    const seen = new Set<number>()
    for (let i = 0; i < 200; i++) seen.add(rule(i * 3, i * 5, 40))
    expect([...seen].sort()).toEqual([0, 2])
  })
})
