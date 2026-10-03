import { defineBlock } from '@elovox/engine/src/blocks/registry.ts'
import { Simulation } from '@elovox/engine/src/sim/simulation.ts'
import { createWorldBuffers } from '@elovox/engine/src/world/buffers.ts'
import { describe, expect, it } from 'vitest'
import { createTerrainGenerator, terrainGenerator } from '../src/generator.ts'
import { encodeValues } from '../src/layers/tiles.ts'
import { builtinOps } from '../src/ops/builtin.ts'
import { defineTerrainOp } from '../src/ops/registry.ts'
import { minimalDoc } from './fixtures.ts'

const BLOCKS = ['stone', 'dirt', 'grass', 'sand', 'water', 'log', 'leaves', 'pine_leaves', 'rock'].map((name) =>
  defineBlock(name === 'water' ? { name, liquid: true, solid: false } : { name }))

function sim(): Simulation {
  return new Simulation({ buffers: createWorldBuffers([64, 64, 64]), blocks: BLOCKS, seed: 9 })
}

describe('terrainGenerator', () => {
  it('generates the document into the world through the engine', () => {
    const s = sim()
    s.configure(terrainGenerator, minimalDoc())
    s.generate(terrainGenerator)
    expect(s.store.getVoxel(10, 19, 10)).toBe(s.registry.id('grass'))
    expect(s.store.getVoxel(10, 20, 10)).toBe(0)
  })

  it('rejects an invalid document with every error and its path', () => {
    expect(() => sim().configure(terrainGenerator, { ...minimalDoc(), seaLevel: -1, ops: [{ id: 'x', type: 'volcano', shape: { kind: 'circle', center: [0, 0], radius: 1 } }] }))
      .toThrow('invalid terrain document:\n  - seaLevel: must be >= 0\n  - ops[0].type: unknown op type "volcano"')
  })

  it('rejects a document whose size differs from the world', () => {
    expect(() => sim().configure(terrainGenerator, { ...minimalDoc(), size: [128, 64] }))
      .toThrow("terrain document size [128, 64] does not match the world's x, z [64, 64]")
  })

  it('rejects a document that uses an unregistered block, naming it', () => {
    expect(() => sim().configure(terrainGenerator, { ...minimalDoc(), biomes: [{ name: 'plain', surface: [{ block: 'snow' }] }] }))
      .toThrow('the terrain document uses block "snow", which is not registered')
  })

  it('keeps the previous document when a new one is rejected', () => {
    const gen = createTerrainGenerator()
    const s = sim()
    s.configure(gen, minimalDoc())
    expect(() => s.configure(gen, { ...minimalDoc(), base: 'flat' })).toThrow()
    s.generate(gen)
    expect(s.store.getVoxel(10, 19, 10)).toBe(s.registry.id('grass'))
  })

  it('explains a missing document', () => {
    expect(() => sim().generate(createTerrainGenerator())).toThrow('the terrain generator has no document: pass `terrain` to createEngine')
  })

  it('accepts custom ops', () => {
    const raise = defineTerrainOp({
      type: 'raise', kind: 'height', defaultBlend: 'add', shapes: ['circle'],
      falloff: false, params: {},
      compile(def) { return { id: def.id, bounds: { x0: 0, z0: 0, x1: 63, z1: 63 }, apply(_x, _z, cell) { cell.h += 5 } } },
    })
    const gen = createTerrainGenerator({ ops: builtinOps.with(raise) })
    const s = sim()
    s.configure(gen, { ...minimalDoc(), ops: [{ id: 'r', type: 'raise', shape: { kind: 'circle', center: [0, 0], radius: 1 } }] })
    s.generate(gen)
    expect(s.store.getVoxel(10, 24, 10)).toBe(s.registry.id('grass'))
  })

  it('round-trips a document with layers through JSON', () => {
    const height = new Int16Array(64 * 64).fill(48) // +3 blocks
    const doc = { ...minimalDoc(), layers: { height: { tiles: [{ x: 0, z: 0, data: encodeValues(height) }] } } }
    const s = sim()
    s.configure(terrainGenerator, JSON.parse(JSON.stringify(doc)))
    s.generate(terrainGenerator)
    expect(s.store.getVoxel(10, 22, 10)).toBe(s.registry.id('grass'))
  })
})
