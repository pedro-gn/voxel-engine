import { describe, expect, it } from 'vitest'
import * as THREE from 'three/webgpu'
import { time } from 'three/tsl'
import { BlockRegistry, LAYER, type BlockDef } from '../src/blocks/registry.ts'
import { Mesher } from '../src/mesh/mesher.ts'
import { meshTablesFrom } from '../src/mesh/tables.ts'
import { FRINGE_BIT } from '../src/mesh/vertexFormat.ts'
import { DecorationRegistry } from '../src/render/decorations/defs.ts'
import { createDecorationMaterials } from '../src/render/decorations/material.ts'
import { WindMask, createDecorationWind, windMaskTexture } from '../src/render/decorations/windMask.ts'
import { LEAF_SWAY_VERTICAL, swayAmplitude } from '../src/render/leafSway.ts'
import { createBodyMaterials, createChunkMaterials } from '../src/render/materials.ts'
import { createLightUniforms } from '../src/render/voxelLighting.ts'
import { ID, TEST_BLOCKS, testRegistry } from './helpers.ts'
import { emptySnap, put } from './meshHelpers.ts'

const TONE = { dark: [0.4, 0.6, 0.4], light: [1.2, 1.3, 1] } as const

describe('leaf sway amplitude', () => {
  it('is ~0.02 block in calm and reaches 0.12 at a gale on exposed ground', () => {
    expect(swayAmplitude(0, 1)).toBeCloseTo(0.02, 10)
    expect(swayAmplitude(1, 1)).toBeCloseTo(0.12, 10)
    expect(swayAmplitude(1, 0)).toBeCloseTo(0.02, 10) // sheltered: the calm sway only
    expect(swayAmplitude(0.1, 1)).toBeLessThan(0.035) // a calm day
    expect(swayAmplitude(0.65, 1)).toBeGreaterThan(swayAmplitude(0.35, 1))
    expect(swayAmplitude(0.65, 1)).toBeGreaterThan(swayAmplitude(0.65, 0.5))
  })
  it('bobs vertically much less than it sways', () => {
    expect(LEAF_SWAY_VERTICAL).toBeGreaterThan(0)
    expect(LEAF_SWAY_VERTICAL).toBeLessThanOrEqual(0.25)
  })
})

describe('sway (BlockDef)', () => {
  it('registry: sway needs a cutout cube and an amount in (0, 1]', () => {
    expect(() => new BlockRegistry([{ name: 'x', textures: 't', sway: 1 }])).toThrow(/sway/)
    expect(() => new BlockRegistry([{ name: 'x', textures: 't', layer: 'cutout', render: false, sway: 1 }])).toThrow(/sway/)
    expect(() => new BlockRegistry([{ name: 'x', textures: 't', layer: 'translucent', sway: 1 }])).toThrow(/sway/)
    expect(() => new BlockRegistry([{ name: 'x', textures: 't', layer: 'cutout', sway: 1.5 }])).toThrow(/sway/)
    expect(() => new BlockRegistry([{ name: 'x', textures: 't', layer: 'cutout', sway: Number.NaN }])).toThrow(/sway/)
    const r = new BlockRegistry([{ name: 'stone' }, { name: 'leaves', layer: 'cutout', sway: 0.5 }])
    expect(r.hasSway).toBe(true)
    expect([...r.sway]).toEqual([0, 0, 0.5])
    expect(testRegistry().hasSway).toBe(false)
  })
  it('registry: blocks sharing a texture must agree on sway', () => {
    expect(() => new BlockRegistry([
      { name: 'a', textures: 'leaves', layer: 'cutout', sway: 1 },
      { name: 'b', textures: 'leaves', layer: 'cutout', sway: 0.5 },
    ])).toThrow(/sway/)
    // A cutout block drawing a swaying texture without sway would sway anyway (the table is per layer).
    expect(() => new BlockRegistry([
      { name: 'a', textures: 'leaves', layer: 'cutout', sway: 1 },
      { name: 'b', textures: { top: 'leaves', side: 'x', bottom: 'x' }, layer: 'cutout' },
    ])).toThrow(/sway/)
    // An opaque block may draw it: only the cutout material sways.
    expect(() => new BlockRegistry([
      { name: 'a', textures: 'leaves', layer: 'cutout', sway: 1 },
      { name: 'b', textures: 'leaves' },
    ])).not.toThrow()
  })
  it('registry: swayLayers holds each layer\'s amount, the fringe texture included, 0 elsewhere', () => {
    const r = new BlockRegistry([{ name: 'log' }, { name: 'leaves', layer: 'cutout', sway: 1, fringe: { texture: 'leaf_fringe' } }])
    const layerOf = new Map(r.textureNames().map((n, i) => [n, i + 1]))
    const s = r.swayLayers(layerOf)
    expect(s.length).toBe(4)
    expect([...s]).toEqual([0, 0, 1, 1]) // checker, log, leaves, leaf_fringe
    expect([...testRegistry().swayLayers(new Map([['stone', 1]]))].every((v) => v === 0)).toBe(true)
  })
})

describe('sway reaches the mesh', () => {
  const mesher = new Mesher()
  function meshWith(leaves: Partial<BlockDef>) {
    const reg = new BlockRegistry(TEST_BLOCKS.map((b) => (b.name === 'leaves' ? { ...b, ...leaves } : b)))
    const layerOf = new Map(reg.textureNames().map((n, i) => [n, i + 1]))
    const tables = meshTablesFrom(reg, reg.faceLayers(layerOf), undefined, reg.fringeLayers(layerOf))
    const s = emptySnap()
    put(s, 5, 5, 5, ID.leaves)
    put(s, 5, 6, 5, ID.leaves)
    put(s, 5, 4, 5, ID.stone)
    const m = mesher.mesh(s, tables)
    const table = reg.swayLayers(layerOf)
    const mask = reg.hasTone ? 255 : 4095
    const swayOf = (lm: { vertices: Uint32Array } | null) => {
      const out: { sway: number; fringe: boolean }[] = []
      for (let i = 0; lm && i < lm.vertices.length; i += 2) out.push({ sway: table[lm.vertices[i + 1]! & mask]!, fringe: (lm.vertices[i]! & FRINGE_BIT) !== 0 })
      return out
    }
    return { reg, cutout: swayOf(m.cutout), opaque: swayOf(m.opaque) }
  }

  it('a chunk with a sway block: its cutout vertices (faces and fringe strips) read a sway, the stone none', () => {
    const r = meshWith({ sway: 1, tone: TONE, fringe: { texture: 'fringe' } })
    expect(r.reg.layer[ID.leaves]).toBe(LAYER.CUTOUT)
    expect(r.cutout.length).toBeGreaterThan(0)
    expect(r.cutout.some((v) => v.fringe)).toBe(true)
    expect(r.cutout.every((v) => v.sway === 1)).toBe(true)
    expect(r.opaque.length).toBeGreaterThan(0)
    expect(r.opaque.every((v) => v.sway === 0)).toBe(true)
  })
  it('a chunk without one reads no sway anywhere', () => {
    const r = meshWith({})
    expect(r.cutout.length).toBeGreaterThan(0)
    expect([...r.cutout, ...r.opaque].every((v) => v.sway === 0)).toBe(true)
  })
})

describe('sway in the chunk materials', () => {
  type N = { getChildren(): Iterable<N> }
  const nodesUnder = (root: unknown): N[] => {
    const seen = new Set<N>(), stack = [root as N]
    while (stack.length) {
      const n = stack.pop()!
      if (!n || seen.has(n)) continue
      seen.add(n)
      for (const c of n.getChildren()) stack.push(c)
    }
    return [...seen]
  }
  const usesTime = (m: { positionNode: unknown }) => nodesUnder(m.positionNode).includes(time as unknown as N)
  const ud = (m: unknown) => (m as { userData: { sway?: boolean } }).userData.sway

  it('only the cutout material sways, on TSL time, and the world without sway is untouched', () => {
    const tex = new THREE.DataArrayTexture(new Uint8Array(4 * 3), 1, 1, 3)
    const lights = createLightUniforms()
    const wind = createDecorationWind(new WindMask(4, 4))
    const layers = new Float32Array([0, 0, 1])
    const swaying = createChunkMaterials(tex, lights, undefined, { sway: { layers, wind } })
    const plain = createChunkMaterials(tex, lights)
    expect(ud(swaying.cutout)).toBe(true)
    expect(usesTime(swaying.cutout)).toBe(true)
    for (const m of [swaying.opaque, swaying.translucent, swaying.liquid, plain.cutout, plain.opaque]) {
      expect(ud(m)).toBeUndefined()
      expect(usesTime(m)).toBe(false)
    }
    // A body (a felled crown falling) never sways: it moves as one piece.
    const body = createBodyMaterials(tex, lights, undefined, { sway: { layers, wind } })
    expect(ud(body.cutout)).toBeUndefined()
    expect(usesTime(body.cutout)).toBe(false)
  })
  it('the leaves and the grass read one exposure texture, re-uploaded on a mask change', () => {
    const mask = new WindMask(4, 4)
    const wind = createDecorationWind(mask)
    const tex = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1)
    const lights = createLightUniforms()
    createChunkMaterials(tex, lights, undefined, { sway: { layers: new Float32Array([0, 1]), wind } })
    createDecorationMaterials(new DecorationRegistry([], testRegistry()), lights, undefined, wind)
    const t = windMaskTexture(mask)
    expect(windMaskTexture(mask)).toBe(t)
    const before = t.version
    mask.set(new Uint8Array(16).fill(7))
    expect(t.version).toBeGreaterThan(before)
  })
})
