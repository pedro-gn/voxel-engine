import { describe, expect, it } from 'vitest'
import { AO_CURVE, flipDiagonal, vertexAO } from '../src/mesh/ao.ts'
import * as THREE from 'three/webgpu'
import { CUT_BIT, FRINGE_BIT, TILT_NORMAL, packA, packB, packTilted, toneLayer, unpackA, unpackB } from '../src/mesh/vertexFormat.ts'
import { FRINGE_LOD_BIAS, fringeVRange } from '../src/render/chunkVertex.ts'
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
  it('keeps the fringe bit clear of every other field of word A', () => {
    const max = (packA(63, 63, 63, 7, 3, 3, 31) | CUT_BIT) >>> 0
    expect(max & FRINGE_BIT).toBe(0)
    expect(CUT_BIT & FRINGE_BIT).toBe(0)
    const marked = (max | FRINGE_BIT) >>> 0
    expect(marked).toBeGreaterThan(0x7fffffff) // stored unsigned
    expect(unpackA(marked)).toEqual(unpackA(max))
    expect(marked & CUT_BIT).toBe(CUT_BIT)
  })
  it('round-trips a tilted roof vertex: position biased by +1, the normal index in the drop bits', () => {
    expect(TILT_NORMAL).toBe(6)
    expect(unpackA(packTilted(-1, 0, 62, 31, 2))).toEqual({ x: -1, y: 0, z: 62, normal: TILT_NORMAL, ao: 0, corner: 2, drop: 0, tilt: 31 })
    expect(unpackA(packTilted(33, -1, 5, 0, 0))).toEqual({ x: 33, y: -1, z: 5, normal: TILT_NORMAL, ao: 0, corner: 0, drop: 0, tilt: 0 })
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

describe('fringe decode (cutout material)', () => {
  it('only the cutout material changes, and its strips cast no shadow', () => {
    const tex = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1)
    const lights = createLightUniforms()
    const plain = createChunkMaterials(tex, lights)
    const fringed = createChunkMaterials(tex, lights, undefined, { fringe: true })
    const ud = (m: unknown) => (m as { userData: { fringe?: boolean } }).userData.fringe
    expect(ud(fringed.cutout)).toBe(true)
    expect(ud(plain.cutout)).toBeUndefined()
    expect(ud(fringed.opaque)).toBeUndefined()
    expect((fringed.cutout as unknown as { maskShadowNode: unknown }).maskShadowNode).toBeTruthy()
    expect((plain.cutout as unknown as { maskShadowNode: unknown }).maskShadowNode).toBeNull()
  })
  it('strips sample the mask clamped to its first and last texel rows, at mip 0 (no wrap, no mip blend)', () => {
    expect(fringeVRange(16)).toEqual([0.5 / 16, 1 - 0.5 / 16])
    expect(FRINGE_LOD_BIAS).toBeLessThanOrEqual(-16) // drives any auto LOD of a 2^16 tile to level 0
    const tex = new THREE.DataArrayTexture(new Uint8Array(4 * 16 * 16), 16, 16, 1)
    const lights = createLightUniforms()
    type N = { isNode?: boolean; isTextureNode?: boolean; value?: unknown; biasNode?: N | null; uvNode?: N | null; method?: string; getChildren(): Iterable<N> }
    /** Every node reachable from a material's colorNode. */
    const nodesOf = (m: unknown): N[] => {
      const seen = new Set<N>(), stack = [(m as { colorNode: N }).colorNode]
      while (stack.length) {
        const n = stack.pop()!
        if (seen.has(n)) continue
        seen.add(n)
        for (const c of n.getChildren()) stack.push(c)
      }
      return [...seen]
    }
    // The albedo sample: the texture node with a layer (depth); bias() also links back to its unbiased base node.
    const samples = (m: unknown) => nodesOf(m).filter((n) => n.isTextureNode === true && n.value === tex && (n as { depthNode?: unknown }).depthNode)
    const constsUnder = (root: N): number[] => {
      const out: number[] = [], seen = new Set<N>(), stack = [root]
      while (stack.length) {
        const n = stack.pop()!
        if (seen.has(n)) continue
        seen.add(n)
        if ((n as { isConstNode?: boolean }).isConstNode) out.push((n as unknown as { value: number }).value)
        for (const c of n.getChildren()) stack.push(c)
      }
      return out
    }
    const clampsUnder = (root: N) => { const all: N[] = []; const seen = new Set<N>(), st = [root]; while (st.length) { const n = st.pop()!; if (seen.has(n)) continue; seen.add(n); if (n.method === 'clamp') all.push(n); for (const c of n.getChildren()) st.push(c) } return all }
    const fringed = samples(createChunkMaterials(tex, lights, undefined, { fringe: true }).cutout)
    expect(fringed.length).toBeGreaterThan(0)
    for (const t of fringed) {
      expect(t.biasNode).toBeTruthy()
      const clamps = clampsUnder(t.uvNode!)
      expect(clamps.length).toBe(1)
      expect(constsUnder(clamps[0]!)).toEqual(expect.arrayContaining([0.5 / 16, 1 - 0.5 / 16]))
    }
    // Without fringe (and on the fringe world's opaque material) the sample is untouched.
    const plainMats = createChunkMaterials(tex, lights)
    const fringedOpaque = createChunkMaterials(tex, lights, undefined, { fringe: true }).opaque
    for (const m of [plainMats.cutout, plainMats.opaque, fringedOpaque]) {
      for (const t of samples(m)) {
        expect(t.biasNode ?? null).toBeNull()
        expect(clampsUnder(t.uvNode!).length).toBe(0)
      }
    }
  })
})
