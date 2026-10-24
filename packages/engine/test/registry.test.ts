import { describe, expect, it } from 'vitest'
import { BlockRegistry, LAYER, defineBlock, waterGroupOf } from '../src/blocks/registry.ts'
import { ID, testRegistry } from './helpers.ts'

describe('BlockRegistry', () => {
  const r = testRegistry()
  it('reserves air as id 0 and assigns ids in definition order', () => {
    expect(r.id('air')).toBe(0)
    expect(r.id('stone')).toBe(ID.stone)
    expect(r.id('leaves')).toBe(ID.leaves)
    expect(r.name(ID.grass)).toBe('grass')
    expect(r.count).toBe(11)
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
  it('records shapes', () => {
    const r = testRegistry()
    expect([r.shape[ID.stone], r.shape[ID.stone_slab], r.shape[ID.stone_stair], r.shape[ID.stone_post]]).toEqual([0, 1, 2, 3])
    expect(r.layer[ID.stone_stair]).toBe(LAYER.SHAPE)
    expect([r.opaque[ID.stone_slab], r.solid[ID.stone_slab], r.structural[ID.stone_slab]]).toEqual([0, 1, 2])
    expect([r.blocksLight[ID.stone], r.blocksLight[ID.stone_slab], r.blocksLight[ID.stone_stair], r.blocksLight[ID.stone_post], r.blocksLight[ID.glass]]).toEqual([1, 1, 1, 0, 0])
    expect(r.faceLayers(new Map([['stone', 7]]))[ID.stone_stair * 6 + 2]).toBe(7)
  })
  it.each([
    [{ liquid: true }, 'liquid'], [{ decoration: 'meadow' }, 'decoration'], [{ render: false }, 'render'],
    [{ falls: true }, 'falls'], [{ layer: 'cutout' as const }, 'layer'],
  ])('rejects a shape combined with %o', (extra, word) => {
    expect(() => new BlockRegistry([{ name: 'x', shape: 'slab', ...extra }])).toThrow(new RegExp(`block "x": shape .*${word}`))
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

it('names the simulated water: the first liquid that is not a spring', () => {
  const reg = new BlockRegistry([
    defineBlock({ name: 'spring', liquid: true, source: 'water' }),
    defineBlock({ name: 'water', liquid: true }),
    defineBlock({ name: 'lava', liquid: true }),
  ])
  expect(waterGroupOf(reg)).toBe(2)
  expect(waterGroupOf(new BlockRegistry([defineBlock({ name: 'stone' })]))).toBe(0)
})

describe('tone', () => {
  const TONE = { dark: [0.4, 0.6, 0.4], light: [1.2, 1.3, 1] } as const
  it('registry: tone requires a cutout cube', () => {
    expect(() => new BlockRegistry([{ name: 'x', textures: 't', tone: { dark: [1, 1, 1], light: [1, 1, 1] } }])).toThrow(/tone/)
    expect(() => new BlockRegistry([{ name: 'x', textures: 't', layer: 'cutout', shape: 'slab', tone: TONE }])).toThrow(/tone/)
    expect(() => new BlockRegistry([{ name: 'x', textures: 't', layer: 'cutout', render: false, tone: TONE }])).toThrow(/tone/)
    expect(() => new BlockRegistry([{ name: 'x', textures: 't', layer: 'translucent', tone: TONE }])).toThrow(/tone/)
    const r = new BlockRegistry([{ name: 'stone' }, { name: 'leaves', layer: 'cutout', tone: TONE }])
    expect(r.hasTone).toBe(true)
    expect([...r.tone]).toEqual([0, 0, 1])
    expect(testRegistry().hasTone).toBe(false)
    expect(testRegistry().tone.every((v) => v === 0)).toBe(true)
  })
  it('registry: two tone blocks sharing a texture must agree', () => {
    expect(() => new BlockRegistry([
      { name: 'a', textures: 'leaves', layer: 'cutout', tone: TONE },
      { name: 'b', textures: 'leaves', layer: 'cutout', tone: { ...TONE, jitter: 0.1 } },
    ])).toThrow(/tone/)
    expect(() => new BlockRegistry([
      { name: 'a', textures: 'leaves', layer: 'cutout', tone: TONE },
      { name: 'b', textures: { top: 'leaves', side: 'x', bottom: 'x' }, layer: 'cutout', tone: { dark: [0.4, 0.6, 0.4], light: [1.2, 1.3, 1], jitter: 0.035 } },
    ])).not.toThrow()
  })
  it('registry: tone limits texture layers to 256', () => {
    const many = Array.from({ length: 257 }, (_, i) => ({ name: `b${i}` }))
    expect(() => new BlockRegistry([...many, { name: 'leaves', layer: 'cutout', tone: TONE }])).toThrow(/tone/)
    expect(() => new BlockRegistry([...many.slice(0, 254), { name: 'leaves', layer: 'cutout', tone: TONE }])).not.toThrow()
    expect(() => new BlockRegistry(many)).not.toThrow() // no tone block, no limit
  })
  it('registry: toneLayers holds each tone layer\'s tints and identity elsewhere', () => {
    const r = new BlockRegistry([{ name: 'stone' }, { name: 'leaves', layer: 'cutout', tone: TONE }])
    const layerOf = new Map(r.textureNames().map((n, i) => [n, i + 1]))
    const t = r.toneLayers(layerOf)
    expect(t.jitter.length).toBe(3)
    expect([...t.dark.subarray(3, 6)]).toEqual([1, 1, 1]) // stone (layer 1)
    expect([...t.light.subarray(3, 6)]).toEqual([1, 1, 1])
    expect(t.jitter[1]).toBe(0)
    expect([...t.dark.subarray(6, 9)].map((v) => +v.toFixed(4))).toEqual([0.4, 0.6, 0.4]) // leaves (layer 2)
    expect([...t.light.subarray(6, 9)].map((v) => +v.toFixed(4))).toEqual([1.2, 1.3, 1])
    expect(t.jitter[2]).toBeCloseTo(0.035)
  })
})

describe('fringe', () => {
  it('registry: fringe needs a cutout cube, and its texture joins the texture list', () => {
    expect(() => new BlockRegistry([{ name: 'x', fringe: { texture: 'f' } }])).toThrow(/fringe/)
    expect(() => new BlockRegistry([{ name: 'x', layer: 'cutout', shape: 'post', fringe: { texture: 'f' } }])).toThrow(/fringe/)
    expect(() => new BlockRegistry([{ name: 'x', layer: 'cutout', fringe: { texture: 'f', width: 0 } }])).toThrow(/fringe/)
    expect(() => new BlockRegistry([{ name: 'x', layer: 'cutout', fringe: { texture: 'f', hang: 1.5 } }])).toThrow(/fringe/)
    const r = new BlockRegistry([{ name: 'stone' }, { name: 'leaves', layer: 'cutout', fringe: { texture: 'leaf_fringe', width: 0.34 } }])
    expect(r.textureNames()).toEqual(['stone', 'leaves', 'leaf_fringe'])
    expect(r.hasFringe).toBe(true)
    expect([...r.fringeWidth]).toEqual([0, 0, 5]) // 0.34 → 5/16
    expect([...r.fringeHang]).toEqual([0, 0, 7])
    expect([...r.fringeLayers(new Map([['stone', 1], ['leaves', 2], ['leaf_fringe', 3]]))]).toEqual([0, 0, 3])
    expect(testRegistry().hasFringe).toBe(false)
  })
  it('registry: a tone block\'s fringe texture carries its tone', () => {
    const tone = { dark: [0.5, 0.5, 0.5], light: [1, 1, 1] } as const
    expect(() => new BlockRegistry([
      { name: 'leaves', layer: 'cutout', tone, fringe: { texture: 'fr' } },
      { name: 'vine', textures: 'fr', layer: 'cutout' },
    ])).toThrow(/tone/)
    const r = new BlockRegistry([{ name: 'leaves', layer: 'cutout', tone, fringe: { texture: 'fr' } }])
    expect([...r.toneLayers(new Map([['leaves', 1], ['fr', 2]])).dark.subarray(6, 9)]).toEqual([0.5, 0.5, 0.5])
  })
  it('registry: strips of two leaves one free cell apart cannot overlap (2·width ≤ 1, width + hang ≤ 1)', () => {
    const leaf = (fringe: { width?: number; hang?: number }) => () =>
      new BlockRegistry([{ name: 'leaves', layer: 'cutout', fringe: { texture: 'f', ...fringe } }])
    expect(leaf({ width: 9 / 16 })).toThrow(/fringe width/)
    expect(leaf({ width: 8 / 16, hang: 9 / 16 })).toThrow(/fringe width \+ hang/)
    expect(leaf({ width: 8 / 16, hang: 8 / 16 })).not.toThrow()
    expect(leaf({ width: 1 / 16, hang: 15 / 16 })).not.toThrow()
  })
  it('registry: fringeReach is the largest strip reach in blocks, 0 without fringe', () => {
    expect(testRegistry().fringeReach).toBe(0)
    expect(new BlockRegistry([{ name: 'leaves', layer: 'cutout', fringe: { texture: 'f' } }]).fringeReach).toBe(7 / 16)
    expect(new BlockRegistry([
      { name: 'leaves', layer: 'cutout', fringe: { texture: 'f', width: 0.5, hang: 0.25 } },
      { name: 'vine', layer: 'cutout', fringe: { texture: 'f', width: 0.25, hang: 0.375 } },
    ]).fringeReach).toBe(0.5)
  })
})
