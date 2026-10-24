import { describe, expect, it } from 'vitest'
import { AO_CURVE, flipDiagonal, vertexAO } from '../src/mesh/ao.ts'
import * as THREE from 'three/webgpu'
import { CUT_BIT, packA, packB, toneLayer, unpackA, unpackB } from '../src/mesh/vertexFormat.ts'
import { createChunkMaterials } from '../src/render/materials.ts'
import { createLightUniforms } from '../src/render/voxelLighting.ts'

describe('vertex format', () => {
  it('round-trips word A at its limits', () => {
    const a = packA(32, 32, 32, 5, 3, 3, 16)
    expect(unpackA(a)).toEqual({ x: 32, y: 32, z: 32, normal: 5, ao: 3, corner: 3, drop: 16 })
    expect(unpackA(packA(0, 1, 2, 0, 0, 1))).toEqual({ x: 0, y: 1, z: 2, normal: 0, ao: 0, corner: 1, drop: 0 })
    expect(a).toBeLessThanOrEqual(0xffffffff)
  })
  it('keeps the layer-cut bit clear of every other field of word A', () => {
    const max = packA(63, 63, 63, 7, 3, 3, 31)
    expect(max & CUT_BIT).toBe(0)
    expect(unpackA((max | CUT_BIT) >>> 0)).toEqual(unpackA(max))
    expect(unpackA((packA(0, 0, 0, 0, 0, 0, 0) | CUT_BIT) >>> 0)).toEqual({ x: 0, y: 0, z: 0, normal: 0, ao: 0, corner: 0, drop: 0 })
  })
  it('round-trips word B at its limits', () => {
    expect(unpackB(packB(4095, 15, 15, 15, 8, 1))).toEqual({ layer: 4095, sky: 15, block: 15, fx: 15, fy: 8, fz: 1 })
    expect(unpackB(packB(7, 3, 2))).toEqual({ layer: 7, sky: 3, block: 2, fx: 0, fy: 0, fz: 0 })
    expect(packB(4095, 15, 15, 15, 15, 15)).toBeGreaterThan(0) // unsigned, even with the top bit set
  })
})

describe('ambient occlusion', () => {
  it('counts occluders, with two sides forcing full occlusion', () => {
    expect(vertexAO(false, false, false)).toBe(0)
    expect(vertexAO(false, false, true)).toBe(1)
    expect(vertexAO(true, false, true)).toBe(2)
    expect(vertexAO(true, true, false)).toBe(3)
    expect(AO_CURVE).toHaveLength(4)
  })
  it('flips to the c1–c3 diagonal when c0+c2 are darker', () => {
    expect(flipDiagonal(3, 0, 0, 0)).toBe(true)
    expect(flipDiagonal(0, 3, 0, 0)).toBe(false)
    expect(flipDiagonal(1, 1, 1, 1)).toBe(false)
  })
})

describe('tone layer bits (cutout stream of a world with tone blocks)', () => {
  it('packs layer | level << 8 | jitter << 10 into the 12-bit layer field', () => {
    expect(toneLayer(37, 0, 0)).toBe(37)
    const b = unpackB(packB(toneLayer(255, 3, 3), 15, 15, 15, 15, 15))
    expect(b.layer).toBe(4095)
    expect(b.sky).toBe(15)
    const l = unpackB(packB(toneLayer(200, 2, 1), 9, 3)).layer
    expect([l & 0xff, (l >> 8) & 3, l >> 10]).toEqual([200, 2, 1])
  })
  it('only the cutout material changes when tone layers are given', () => {
    const tex = new THREE.DataArrayTexture(new Uint8Array(4 * 3), 1, 1, 3)
    const lights = createLightUniforms()
    const plain = createChunkMaterials(tex, lights)
    const dark = new Float32Array(9).fill(1), light = new Float32Array(9).fill(1), jitter = new Float32Array(3)
    dark.set([0.5, 0.6, 0.5], 6); light.set([1.2, 1.2, 1], 6); jitter[2] = 0.035
    const toned = createChunkMaterials(tex, lights, undefined, { tone: { dark, light, jitter } })
    for (const m of [plain.opaque, plain.cutout, toned.opaque, toned.cutout]) expect(m.colorNode).toBeTruthy()
    expect((toned.cutout as unknown as { userData: { tone?: boolean } }).userData.tone).toBe(true)
    expect((plain.cutout as unknown as { userData: { tone?: boolean } }).userData.tone).toBeUndefined()
    expect((toned.opaque as unknown as { userData: { tone?: boolean } }).userData.tone).toBeUndefined()
  })
})
