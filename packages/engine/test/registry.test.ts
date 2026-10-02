import { describe, expect, it } from 'vitest'
import { BlockRegistry, LAYER, defineBlock } from '../src/blocks/registry.ts'
import { ID, testRegistry } from './helpers.ts'

describe('BlockRegistry', () => {
  const r = testRegistry()
  it('reserves air as id 0 and assigns ids in definition order', () => {
    expect(r.id('air')).toBe(0)
    expect(r.id('stone')).toBe(ID.stone)
    expect(r.id('leaves')).toBe(ID.leaves)
    expect(r.name(ID.grass)).toBe('grass')
    expect(r.count).toBe(8)
  })
  it('derives flag tables with defaults', () => {
    expect(r.opaque[ID.air]).toBe(0)
    expect(r.opaque[ID.stone]).toBe(1)
    expect(r.opaque[ID.glass]).toBe(0)
    expect(r.opaque[ID.torch]).toBe(0)
    expect(r.solid[ID.stone]).toBe(1)
    expect(r.solid[ID.water]).toBe(0)
    expect(r.solid[ID.air]).toBe(0)
    expect(r.layer[ID.air]).toBe(LAYER.NONE)
    expect(r.layer[ID.stone]).toBe(LAYER.OPAQUE)
    expect(r.layer[ID.torch]).toBe(LAYER.CUTOUT)
    expect(r.layer[ID.water]).toBe(LAYER.TRANSLUCENT) // liquids default to translucent
    expect(r.liquid[ID.water]).toBe(1)
    expect(r.emits[ID.torch]).toBe(14)
  })
  it('defaults liquids to non-solid unless solid is given', () => {
    const lr = new BlockRegistry([defineBlock({ name: 'lava', liquid: true }), defineBlock({ name: 'slime', liquid: true, solid: true })])
    expect(lr.solid[lr.id('lava')]).toBe(0)
    expect(lr.solid[lr.id('slime')]).toBe(1)
  })
  it('lists unique texture names in first-appearance order', () => {
    // faces are visited side, side, top, bottom, side, side → grass_side comes before grass_top
    expect(r.textureNames()).toEqual(['stone', 'dirt', 'grass_side', 'grass_top', 'glass', 'water', 'torch', 'leaves'])
  })
  it('maps faces (+X,-X,+Y,-Y,+Z,-Z) to texture layers', () => {
    const layerOf = new Map(r.textureNames().map((n, i) => [n, i + 1]))
    layerOf.delete('leaves')
    const f = r.faceLayers(layerOf)
    const g = ID.grass * 6
    // grass_side = 3, grass_top = 4, dirt = 2
    expect(Array.from(f.subarray(g, g + 6))).toEqual([3, 3, 4, 2, 3, 3])
    expect(f[ID.stone * 6]).toBe(1)
    expect(f[ID.leaves * 6]).toBe(0) // missing texture → checker layer 0
  })
  it('validates definitions', () => {
    expect(() => r.id('nope')).toThrow(/unknown block/i)
    expect(() => new BlockRegistry([defineBlock({ name: 'air' })])).toThrow(/reserved/)
    expect(() => new BlockRegistry([defineBlock({ name: 'a' }), defineBlock({ name: 'a' })])).toThrow(/duplicate/)
    expect(() => new BlockRegistry([defineBlock({ name: 'a', emits: 16 })])).toThrow(/emits/)
    const many = Array.from({ length: 4096 }, (_, i) => defineBlock({ name: `b${i}` }))
    expect(() => new BlockRegistry(many)).toThrow(/too many/)
  })
})
