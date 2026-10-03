import { defineBlock } from '@elovox/engine/src/blocks/registry.ts'
import { Simulation } from '@elovox/engine/src/sim/simulation.ts'
import { createWorldBuffers } from '@elovox/engine/src/world/buffers.ts'
import { describe, expect, it } from 'vitest'
import type { TerrainDoc, TerrainLayers } from '../src/doc/types.ts'
import { validateTerrainDoc } from '../src/doc/validate.ts'
import { createTerrainGenerator } from '../src/generator.ts'
import { checkPatch, diffLayers } from '../src/layers/patch.ts'
import { BIOME_VALUES, BRICK_VALUES, HEIGHT_VALUES } from '../src/layers/tiles.ts'
import { minimalDoc } from './fixtures.ts'

const BLOCKS = ['stone', 'dirt', 'grass', 'sand', 'water', 'log', 'leaves', 'pine_leaves', 'rock'].map((name) =>
  defineBlock(name === 'water' ? { name, liquid: true, solid: false } : { name }))
const limits = { sizeX: 64, sizeZ: 64, height: 64, biomeCount: 2 }

function plainDoc(): TerrainDoc {
  const r = validateTerrainDoc(minimalDoc(), { worldHeight: 64 })
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r.doc
}
function paint(): TerrainLayers {
  const density = new Int8Array(BRICK_VALUES)
  density[4 + 4 * 8 + 1 * 64] = -60
  return {
    height: { tiles: [{ x: 0, z: 0, values: new Int16Array(HEIGHT_VALUES).fill(40) }] },
    biome: { tiles: [{ x: 0, z: 0, values: new Uint8Array(BIOME_VALUES).fill(2) }] },
    density: { bricks: [{ x: 1, y: 1, z: 1, values: density }] },
  }
}
/** The world hash after configure(first) and, if given, patch(diffLayers(first.layers, then.layers)). */
function worldHash(first: TerrainDoc, then?: TerrainDoc): number {
  const gen = createTerrainGenerator()
  const s = new Simulation({ buffers: createWorldBuffers([64, 64, 64]), blocks: BLOCKS, seed: 9 })
  s.configure(gen, first)
  if (then) gen.patch!(diffLayers(first.layers, then.layers))
  s.generate(gen)
  return s.hash()
}

describe('diffLayers', () => {
  it('lists the tiles b does not share with a, and removals for tiles only a has', () => {
    const p = paint()
    const kept = p.height!.tiles[0]!
    const changed = { x: 0, z: 0, values: new Uint8Array(BIOME_VALUES).fill(1) }
    const b: TerrainLayers = { height: p.height, biome: { tiles: [changed] } }
    expect(diffLayers(p, b)).toEqual({ biome: [{ x: 0, z: 0, values: changed.values }], density: [{ x: 1, y: 1, z: 1, values: null }] })
    expect(diffLayers(p, p)).toEqual({})
    expect(diffLayers({}, { height: { tiles: [kept] } })).toEqual({ height: [{ x: 0, z: 0, values: kept.values }] })
  })
})

describe('checkPatch', () => {
  it('reports keys outside the world, wrong arrays and biome values past the count', () => {
    expect(checkPatch({
      height: [{ x: 1, z: 0, values: null }, { x: 0, z: 0, values: new Int8Array(4) }],
      biome: [{ x: 0, z: 0, values: new Uint8Array(BIOME_VALUES).fill(3) }],
      density: [{ x: 0, y: 4, z: 0, values: null }],
      water: [],
    }, limits)).toEqual([
      'patch.water: unknown layer (known: height, biome, density)',
      'patch.height[0].x: must be <= 0',
      'patch.height[1].values: must be null or an Int16Array of 4096 values',
      'patch.biome[0].values: value 3 at cell (0, 0) exceeds the 2 biomes',
      'patch.density[0].y: must be <= 3',
    ])
    expect(checkPatch('x', limits)).toEqual(['patch: must be an object'])
    expect(checkPatch({}, limits)).toEqual([])
  })
})

describe('terrain generator patch', () => {
  it('configure then patch generates the same world as configure with the painted document', () => {
    const plain = plainDoc()
    const painted = { ...plain, layers: paint() }
    expect(worldHash(plain, painted)).toBe(worldHash(painted))
    expect(worldHash(painted)).not.toBe(worldHash(plain)) // the paint matters
  })

  it('a patch that removes the paint gives the plain world back', () => {
    const plain = plainDoc()
    expect(worldHash({ ...plain, layers: paint() }, plain)).toBe(worldHash(plain))
  })

  it('refuses an invalid patch and keeps generating the configured document', () => {
    const plain = plainDoc()
    const gen = createTerrainGenerator()
    const s = new Simulation({ buffers: createWorldBuffers([64, 64, 64]), blocks: BLOCKS, seed: 9 })
    s.configure(gen, plain)
    expect(() => gen.patch!({ biome: [{ x: 0, z: 0, values: new Uint8Array(BIOME_VALUES).fill(9) }] }))
      .toThrow('invalid terrain patch:\n  - patch.biome[0].values: value 9 at cell (0, 0) exceeds the 2 biomes')
    s.generate(gen)
    expect(s.hash()).toBe(worldHash(plain))
  })

  it('refuses a patch before any document', () => {
    expect(() => createTerrainGenerator().patch!({})).toThrow('the terrain generator has no document to patch')
  })
})
