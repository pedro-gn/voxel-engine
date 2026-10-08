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
  it('keeps every chunk\'s vertex and index data intact through compaction, in place remeshes and appends', () => {
    /** n quads whose second vertex word is unique per chunk and vertex, so any misplaced copy shows. */
    const tagged = (n: number, tag: number): LayerMesh => {
      const m = quads(n)
      for (let v = 0; v < n * 4; v++) m.vertices[v * 2 + 1] = tag * 100_000 + v
      return m
    }
    const b = batches()
    const meshes = new Map<string, LayerMesh>()
    const put = (ci: number, cy: number, n: number) => { const m = tagged(n, ci + 1); meshes.set(`0,${cy},0`, m); b.set(ci, 0, cy, 0, m) }
    // 2500, 7500 and 10000 reserved vertices. Removing the first and third frees 12500 (> 30% of 32768); the kept middle
    // chunk then moves down by 2500, less than its own 7500: its old and new ranges overlap.
    put(0, 0, 500); put(1, 1, 1500); put(2, 2, 2000)
    b.remove(0); b.remove(2)
    meshes.delete('0,0,0'); meshes.delete('0,2,0')
    put(3, 3, 3000) // needs room: compacts
    expect(b.stats.compacted).toBe(1)
    put(3, 3, 2900) // fits its reservation: in place (chunk 1 keeps the data compaction moved)
    put(4, 4, 10)
    put(4, 4, 200) // outgrows it: append
    expect(b.stats).toMatchObject({ inPlace: 1, appended: 1 })
    const batch = bm(b)[0]! as unknown as THREE.BatchedMesh & {
      _instanceInfo: { active: boolean; geometryIndex: number }[]
      _geometryInfo: { vertexStart: number; vertexCount: number; indexStart: number; indexCount: number }[]
    }
    const packed = batch.geometry.getAttribute('packed').array as Uint32Array
    const index = batch.geometry.getIndex()!.array as Uint32Array
    const m = new THREE.Matrix4(), p = new THREE.Vector3()
    let checked = 0
    batch._instanceInfo.forEach((inst, i) => {
      if (!inst.active) return
      batch.getMatrixAt(i, m)
      p.setFromMatrixPosition(m)
      const want = meshes.get(`${(p.x - 16) / 32},${(p.y - 16) / 32},${(p.z - 16) / 32}`)!
      const g = batch._geometryInfo[inst.geometryIndex]!
      expect(g.vertexCount).toBe(want.vertices.length / 2)
      expect(Array.from(packed.subarray(g.vertexStart * 2, (g.vertexStart + g.vertexCount) * 2))).toEqual(Array.from(want.vertices))
      expect(Array.from(index.subarray(g.indexStart, g.indexStart + g.indexCount), (x) => x - g.vertexStart)).toEqual(Array.from(want.indices))
      checked++
    })
    expect(checked).toBe(3)
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
