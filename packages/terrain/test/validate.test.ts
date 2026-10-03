import { describe, expect, it } from 'vitest'
import { TerrainDocError, validateTerrainDoc } from '../src/doc/validate.ts'
import { encodeRaster } from '../src/layers/raster.ts'
import { OpRegistry, defineTerrainOp } from '../src/ops/registry.ts'
import { minimalDoc } from './fixtures.ts'

/** A custom op, which also proves custom ops plug into validation. */
const bump = defineTerrainOp({
  type: 'bump', kind: 'height', defaultBlend: 'add', shapes: ['circle'], falloff: false,
  params: { height: { type: 'number', required: true, default: 0, min: 0 } },
  compile(def) { return { id: def.id, bounds: { x0: 0, z0: 0, x1: 0, z1: 0 }, apply() {} } },
})
const ops = new OpRegistry([bump])
const circle = { kind: 'circle', center: [10, 10], radius: 5 }

function errorsOf(doc: unknown): string[] {
  const r = validateTerrainDoc(doc, { ops })
  return r.ok ? [] : r.errors
}

describe('validateTerrainDoc', () => {
  it('accepts a minimal document and fills defaults', () => {
    const r = validateTerrainDoc(minimalDoc(), { ops })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.doc.blocks).toEqual({ fill: 'stone', water: 'water', log: 'log', leaves: 'leaves', pineLeaves: 'pine_leaves', rock: 'rock' })
    expect(r.doc.layers).toEqual({})
    expect(r.doc.ops).toEqual([])
  })

  it('normalizes ops: enabled defaults to true, params to {}', () => {
    const doc = { ...minimalDoc(), ops: [{ id: 'a', type: 'bump', shape: circle, params: { height: 3 } }, { id: 'b', type: 'bump', enabled: false, shape: circle, params: { height: 1 }, blend: 'max' }] }
    const r = validateTerrainDoc(doc, { ops })
    expect(r.ok && r.doc.ops).toEqual([
      { id: 'a', type: 'bump', enabled: true, shape: circle, params: { height: 3 } },
      { id: 'b', type: 'bump', enabled: false, shape: circle, params: { height: 1 }, blend: 'max' },
    ])
  })

  it('rejects things that are not documents', () => {
    expect(errorsOf(null)).toEqual(['(document): must be an object'])
    expect(errorsOf([])).toEqual(['(document): must be an object'])
  })

  it('reports format, version, size and sea level problems', () => {
    expect(errorsOf({ ...minimalDoc(), format: 'x', version: 2, size: [64, 50], seaLevel: 128 })).toEqual([
      'format: must be "elovox-terrain"',
      'version: unsupported version 2 (this build reads version 1)',
      'size[1]: must be a positive multiple of 32',
      'seaLevel: must be <= 127',
    ])
  })

  it('reports biome problems with paths', () => {
    const doc = {
      ...minimalDoc(),
      biomes: [
        { name: 'plain', surface: [{ depth: [1, 0] }], trees: { density: 2, kinds: ['palm'] }, rocks: { density: 0.1, size: [1, 9] } },
        { name: 'plain', surface: [{ bands: { blocks: [], thickness: 0 } }] },
      ],
      biomeRule: { default: 'desert', rules: [{ biome: 'plain', moisture: [0.8, 0.2] }] },
    }
    expect(errorsOf(doc)).toEqual([
      'biomes[0].surface[0].block: is required',
      'biomes[0].surface[0].depth: min must be <= max',
      'biomes[0].trees.density: must be <= 1',
      'biomes[0].trees.kinds[0]: must be one of broadleaf, pine, bush',
      'biomes[0].rocks.size: must be within [1, 6]',
      'biomes[1].name: duplicate biome "plain"',
      'biomes[1].surface[0].bands.blocks: must have at least 1 item',
      'biomes[1].surface[0].bands.thickness: must be >= 1',
      'biomeRule.default: must be one of plain',
      'biomeRule.rules[0].moisture: min must be <= max',
    ])
  })

  it('reports op problems with paths, including unknown types and custom-op params', () => {
    const doc = {
      ...minimalDoc(),
      ops: [
        { id: 'a', type: 'bump', shape: circle, params: { height: -1 } },
        { id: 'a', type: 'bump', shape: { kind: 'path', width: 3, points: [{ x: 0, z: 0 }, { x: 1, z: 1 }] }, params: { height: 1 } },
        { id: 'c', type: 'volcano', shape: circle },
        { id: 'd', type: 'bump', shape: circle, params: { height: 1 }, blend: 'mix', enabled: 'yes' },
      ],
    }
    expect(errorsOf(doc)).toEqual([
      'ops[0].params.height: must be >= 0',
      'ops[1].id: duplicate id "a"',
      'ops[1].shape.kind: must be one of circle',
      'ops[2].type: unknown op type "volcano" (known: bump)',
      'ops[3].enabled: must be true or false',
      'ops[3].blend: must be one of add, carve, max, min, set',
    ])
  })

  it('validates layers against the document size', () => {
    const doc = { ...minimalDoc(), layers: { height: encodeRaster('i16', 32, 32, new Int16Array(1024)) } }
    expect(errorsOf(doc)).toEqual(['layers.height: must be 64 × 64, got 32 × 32'])
  })

  it('rejects unknown block keys', () => {
    expect(errorsOf({ ...minimalDoc(), blocks: { fill: 'stone', lava: 'x' } })).toEqual(['blocks.lava: unknown key (known: fill, water, log, leaves, pineLeaves, rock)'])
  })
})

describe('TerrainDocError', () => {
  it('lists every error in its message', () => {
    const e = new TerrainDocError(['a: x', 'b: y'])
    expect(e.message).toBe('invalid terrain document:\n  - a: x\n  - b: y')
    expect(e.errors).toEqual(['a: x', 'b: y'])
  })
})
