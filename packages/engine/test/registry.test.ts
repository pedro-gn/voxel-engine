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
    expect(r.layer[ID.water]).toBe(LAYER.LIQUID) // liquids default to the liquid layer
    expect(r.liquid[ID.water]).toBe(1)
    expect(r.emits[ID.torch]).toBe(14)
  })
  it('defaults liquids to non-solid unless solid is given', () => {
    const lr = new BlockRegistry([defineBlock({ name: 'lava', liquid: true }), defineBlock({ name: 'slime', liquid: true, solid: true })])
    expect(lr.solid[lr.id('lava')]).toBe(0)
    expect(lr.solid[lr.id('slime')]).toBe(1)
  })
  it('only allows the liquid layer on liquid blocks', () => {
    expect(() => new BlockRegistry([defineBlock({ name: 'goo', layer: 'liquid' })])).toThrow(/block "goo": layer "liquid" needs liquid: true/)
    const r = new BlockRegistry([defineBlock({ name: 'syrup', liquid: true, layer: 'translucent' })])
    expect(r.layer[r.id('syrup')]).toBe(LAYER.TRANSLUCENT)
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
  it('records falls, springs and liquid groups', () => {
    const r2 = new BlockRegistry([
      defineBlock({ name: 'water', liquid: true }),
      defineBlock({ name: 'spring', liquid: true, source: 'water', textures: 'water' }),
      defineBlock({ name: 'sand', falls: true }),
      defineBlock({ name: 'stone' }),
    ])
    const [water, spring, sand, stone] = [1, 2, 3, 4]
    expect(r2.falls[sand]).toBe(1)
    expect(r2.falls[stone]).toBe(0)
    expect(r2.source[spring]).toBe(1)
    expect(r2.source[water]).toBe(0)
    expect(r2.liquidGroup[water]).toBe(water)
    expect(r2.liquidGroup[spring]).toBe(water)
    expect(r2.liquidGroup[stone]).toBe(0)
    expect(r2.liquidGroup[0]).toBe(0)
  })
  it('rejects falls on a liquid and bad sources', () => {
    expect(() => new BlockRegistry([defineBlock({ name: 'w', liquid: true, falls: true })])).toThrow(/falls cannot be combined with liquid/)
    expect(() => new BlockRegistry([defineBlock({ name: 's', source: 'w' })])).toThrow(/source needs liquid: true/)
    expect(() => new BlockRegistry([defineBlock({ name: 's', liquid: true, source: 'nope' })])).toThrow(/names "nope", which is not a block/)
    expect(() => new BlockRegistry([defineBlock({ name: 'stone' }), defineBlock({ name: 's', liquid: true, source: 'stone' })]))
      .toThrow(/must be a liquid that is not itself a source/)
    expect(() => new BlockRegistry([
      defineBlock({ name: 'w', liquid: true }),
      defineBlock({ name: 'a', liquid: true, source: 'w' }),
      defineBlock({ name: 'b', liquid: true, source: 'a' }),
    ])).toThrow(/must be a liquid that is not itself a source/)
  })
})
