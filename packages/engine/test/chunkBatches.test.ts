import * as THREE from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import type { LayerMesh } from '../src/mesh/quadBuilder.ts'
import { FACE, packA } from '../src/mesh/vertexFormat.ts'
import { ChunkBatches, PassGuard, REGION } from '../src/render/chunkBatches.ts'
import { Layout } from '../src/world/layout.ts'

/** n +Y quads in a row at y 2 (4 vertices, 6 indices each). */
function quads(n: number): LayerMesh {
  const vertices = new Uint32Array(n * 8), indices = new Uint32Array(n * 6)
  for (let q = 0; q < n; q++) {
    for (let c = 0; c < 4; c++) vertices[(q * 4 + c) * 2] = packA((q % 30) + (c === 1 || c === 2 ? 1 : 0), 2, 1 + (c >= 2 ? 1 : 0), FACE.PY, 0, c, 0)
    indices.set([0, 1, 2, 0, 2, 3].map(i => i + q * 4), q * 6)
  }
  return { vertices, indices }
}
const layout = new Layout([256, 64, 256])
const batches = () => new ChunkBatches(layout, new THREE.MeshBasicMaterial(), 'opaque', true)
const bm = (b: ChunkBatches) => b.group.children as THREE.BatchedMesh[]

describe('ChunkBatches', () => {
  it('puts chunks of one 4 × 4-column region in one batch, translated to the chunk centre, with explicit finite bounds', () => {
    const b = batches()
    b.set(layout.chunkIndex(0, 0, 0), 0, 0, 0, quads(1))
    b.set(layout.chunkIndex(REGION - 1, 1, REGION - 1), REGION - 1, 1, REGION - 1, quads(1))
    b.set(layout.chunkIndex(REGION, 0, 0), REGION, 0, 0, quads(1))
    expect(b.batchCount).toBe(2)
    expect(b.instanceCount).toBe(3)
    const first = bm(b)[0]!, m = new THREE.Matrix4()
    first.getMatrixAt(1, m)
    expect(new THREE.Vector3().setFromMatrixPosition(m).toArray()).toEqual([(REGION - 1) * 32 + 16, 48, (REGION - 1) * 32 + 16])
    expect(Number.isFinite(first.geometry.boundingSphere!.radius)).toBe(true)
    expect(first.geometry.boundingBox!.max.toArray()).toEqual([REGION * 32, 64, REGION * 32])
  })
  it('keeps the integer packed attribute aliased as position, also after growing', () => {
    const b = batches()
    for (let i = 0; i < 16; i++) b.set(i, i % 8, 0, 0, quads(900)) // forces at least one grow of the first batch
    const g = bm(b)[0]!.geometry
    expect(b.stats.grown).toBeGreaterThan(0)
    expect(g.getAttribute('position')).toBe(g.getAttribute('packed'))
    expect((g.getAttribute('packed') as THREE.BufferAttribute).gpuType).toBe(THREE.IntType)
  })
  it('remeshes in place when the new mesh fits its reserved slack, and appends when it does not', () => {
    const b = batches()
    b.set(0, 0, 0, 0, quads(8))
    b.set(0, 0, 0, 0, quads(9)) // within 25% slack
    expect(b.stats).toMatchObject({ inPlace: 1, appended: 0 })
    b.set(0, 0, 0, 0, quads(40))
    expect(b.stats).toMatchObject({ inPlace: 1, appended: 1 })
    expect(b.instanceCount).toBe(1)
  })
  it('removes a chunk, and compacts a batch whose freed space passes 30% when it needs room', () => {
    const b = batches()
    for (let i = 0; i < 10; i++) b.set(i, 0, i, 0, quads(600)) // 10 × 3000 reserved vertices: fits the initial 32 × 1024
    for (let i = 0; i < 6; i++) b.remove(i)
    expect(b.instanceCount).toBe(4)
    for (let i = 10; i < 20; i++) b.set(i, 1, i - 10, 0, quads(600)) // the 11th needs room; 6 × 3000 freed is over 30%
    expect(b.stats.compacted).toBeGreaterThan(0)
    expect(b.instanceCount).toBe(14)
  })
  it('never raycasts', () => {
    const b = batches()
    b.set(0, 0, 0, 0, quads(1))
    const hits: THREE.Intersection[] = []
    bm(b)[0]!.raycast(new THREE.Raycaster(), hits)
    expect(hits).toEqual([])
  })
})

describe('PassGuard', () => {
  it('returns the outer camera after a nested pass, and nothing after the outermost', () => {
    const g = new PassGuard(), main = new THREE.PerspectiveCamera(), shadow = new THREE.OrthographicCamera()
    g.enter(main); g.enter(shadow)
    expect(g.exit()).toBe(main) // the shadow pass ended inside the main one: restore main's draw list
    expect(g.exit()).toBeNull()
  })
})

describe('three internals this module relies on (re-check on every three upgrade)', () => {
  it('BatchedMesh still has the private fields ChunkBatches uses', () => {
    expect(THREE.REVISION).toBe('186')
    const m = new THREE.BatchedMesh(1, 4, 6, new THREE.MeshBasicMaterial()) as unknown as Record<string, unknown>
    for (const k of ['_indirectTexture', '_matricesTexture', '_geometryInfo', '_maxVertexCount', '_maxIndexCount', '_geometryInitialized', '_nextVertexStart', '_nextIndexStart']) expect(k in m, k).toBe(true)
  })
})
