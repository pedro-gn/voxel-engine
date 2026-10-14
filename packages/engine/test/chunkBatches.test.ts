import * as THREE from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import type { LayerMesh } from '../src/mesh/quadBuilder.ts'
import { FACE, packA } from '../src/mesh/vertexFormat.ts'
import { CUTOUT_INDICES_PER_SLOT, CUTOUT_VERTICES_PER_SLOT, ChunkBatches, PassGuard, REGION } from '../src/render/chunkBatches.ts'
import { ChunkMeshes } from '../src/render/chunkMeshes.ts'
import { LayerCut } from '../src/render/layerCut.ts'
import type { ChunkMaterials } from '../src/render/materials.ts'
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
/** Region-4 batches (32 slots × 1024 vertices on this layout) grow and compact after a few chunks; the mechanics are the same at any region size. */
const small = () => new ChunkBatches(layout, new THREE.MeshBasicMaterial(), 'opaque', true, { region: 4 })
const bm = (b: ChunkBatches) => b.group.children as THREE.BatchedMesh[]

describe('ChunkBatches', () => {
  it('puts chunks of one REGION × REGION-column region in one batch, translated to the chunk centre, with explicit finite bounds', () => {
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
    const b = small()
    for (let i = 0; i < 16; i++) b.set(i, i % 8, 0, 0, quads(900)) // forces at least one grow of the first batch
    const g = bm(b)[0]!.geometry
    expect(b.stats.grown).toBeGreaterThan(0)
    expect(g.getAttribute('position')).toBe(g.getAttribute('packed'))
    expect((g.getAttribute('packed') as THREE.BufferAttribute).gpuType).toBe(THREE.IntType)
  })
  it('aliases normal (and position) to the packed attribute, also after growing, so three\'s batch normal finds one', () => {
    const b = small()
    b.set(0, 0, 0, 0, quads(1))
    expect(bm(b)[0]!.geometry.getAttribute('normal')).toBe(bm(b)[0]!.geometry.getAttribute('packed'))
    for (let i = 0; i < 16; i++) b.set(i, i % 8, 0, 0, quads(900))
    const g = bm(b)[0]!.geometry
    expect(b.stats.grown).toBeGreaterThan(0)
    expect(g.getAttribute('normal')).toBe(g.getAttribute('packed'))
  })
  it('hands the buffers a grow replaced to releaseRetired once', () => {
    const b = small()
    const before = bm(b).length
    b.set(0, 0, 0, 0, quads(1))
    const old = [bm(b)[before]!.geometry.getAttribute('packed'), bm(b)[before]!.geometry.getIndex()]
    for (let i = 1; i < 16; i++) b.set(i, i % 4, (i / 4) | 0, 0, quads(900)) // the first region's batch grows
    const freed: THREE.BufferAttribute[] = []
    b.releaseRetired(a => freed.push(a))
    expect(freed).toContain(old[0])
    expect(freed).toContain(old[1])
    expect(freed.length % 2).toBe(0) // vertex + index per grow
    const again: THREE.BufferAttribute[] = []
    b.releaseRetired(a => again.push(a))
    expect(again).toEqual([])
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
    const b = small()
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
    const b = small()
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
  it('reports the bytes its batches reserve', () => {
    const b = batches()
    expect(b.capacityBytes).toBe(0)
    b.set(0, 0, 0, 0, quads(1))
    expect(b.capacityBytes).toBe(REGION * REGION * 2 * (1024 * 8 + 1536 * 4)) // layout 64 tall: 2 chunk layers per column
  })
  it('starts cutout batches at half the opaque capacity per slot', () => {
    const opaque = batches()
    const cutout = new ChunkBatches(layout, new THREE.MeshBasicMaterial(), 'cutout', true, { verticesPerSlot: CUTOUT_VERTICES_PER_SLOT, indicesPerSlot: CUTOUT_INDICES_PER_SLOT })
    opaque.set(0, 0, 0, 0, quads(1)); cutout.set(0, 0, 0, 0, quads(1))
    expect(cutout.capacityBytes).toBe(opaque.capacityBytes / 2)
  })
  it('gives the cutout layer of ChunkMeshes the cutout slot sizes', () => {
    const m = () => new THREE.MeshBasicMaterial()
    const cm = new ChunkMeshes(layout, { opaque: m(), cutout: m(), translucent: m(), liquid: m() } as unknown as ChunkMaterials, { batched: true })
    cm.apply(0, { opaque: quads(1), cutout: null, translucent: null, liquid: null, grass: null, flowers: null })
    const opaqueOnly = cm.batchBytes
    cm.apply(1, { opaque: null, cutout: quads(1), translucent: null, liquid: null, grass: null, flowers: null })
    expect(cm.batchBytes - opaqueOnly).toBe(opaqueOnly / 2)
  })
  it('groups 8 × 8 columns per batch with region 8', () => {
    const b = new ChunkBatches(layout, new THREE.MeshBasicMaterial(), 'opaque', true, { region: 8 })
    b.set(layout.chunkIndex(0, 0, 0), 0, 0, 0, quads(1))
    b.set(layout.chunkIndex(7, 0, 7), 7, 0, 7, quads(1))
    b.set(layout.chunkIndex(8, 0, 0), 8, 0, 0, quads(1))
    expect(b.batchCount).toBe(2)
    expect(bm(b)[0]!.geometry.boundingBox!.max.toArray()).toEqual([256, 64, 256])
  })
  it('groups 8 × 8 columns per batch by default (spec 4b §4.2: adopted on the window-4 re-A/B)', () => {
    const b = batches()
    b.set(layout.chunkIndex(0, 0, 0), 0, 0, 0, quads(1))
    b.set(layout.chunkIndex(7, 1, 7), 7, 1, 7, quads(1))
    expect(REGION).toBe(8)
    expect(b.batchCount).toBe(1)
  })
  it('still groups 4 × 4 columns with region 4', () => {
    const b = new ChunkBatches(layout, new THREE.MeshBasicMaterial(), 'opaque', true, { region: 4 })
    b.set(layout.chunkIndex(0, 0, 0), 0, 0, 0, quads(1))
    b.set(layout.chunkIndex(4, 0, 0), 4, 0, 0, quads(1))
    expect(b.batchCount).toBe(2)
  })
  it('logs remesh costs per region size (spec 4b §4.2; numbers are logged, not asserted)', () => {
    for (const region of [4, 8]) {
      const big = new Layout([1024, 128, 1024])
      const b = new ChunkBatches(big, new THREE.MeshBasicMaterial(), 'opaque', true, { region })
      for (let i = 0; i < region * region * 4; i++) {
        const cx = i % region, cz = ((i / region) | 0) % region, cy = (i / (region * region)) | 0
        b.set(big.chunkIndex(cx, cy, cz), cx, cy, cz, quads(400))
      }
      const time = (f: () => void) => { const t = performance.now(); f(); return performance.now() - t }
      const first = big.chunkIndex(0, 0, 0)
      const inPlace = time(() => b.set(first, 0, 0, 0, quads(410)))
      const append = time(() => b.set(first, 0, 0, 0, quads(900)))
      for (let cx = 1; cx < region; cx++) b.remove(big.chunkIndex(cx, 0, 0))
      const compact = time(() => b.set(big.chunkIndex(1, 0, 0), 1, 0, 0, quads(6000)))
      console.log(`region ${region}: in place ${inPlace.toFixed(2)} ms, append ${append.toFixed(2)} ms, compact/grow ${compact.toFixed(2)} ms (stats ${JSON.stringify(b.stats)})`)
      expect(b.instanceCount).toBe(region * region * 4 - (region - 1) + 1)
    }
  })
  it('never raycasts', () => {
    const b = batches()
    b.set(0, 0, 0, 0, quads(1))
    const hits: THREE.Intersection[] = []
    bm(b)[0]!.raycast(new THREE.Raycaster(), hits)
    expect(hits).toEqual([])
  })
})

/** Runs a batch's onBeforeRender then onAfterRender for `camera`, as three's renderer does, and returns its draw count. */
function render(b: THREE.BatchedMesh, camera: THREE.Camera): number {
  camera.updateMatrixWorld()
  ;(b.onBeforeRender as unknown as (...a: unknown[]) => void)(null, null, camera, b.geometry, b.material, null)
  const n = (b as unknown as { _multiDrawCount: number })._multiDrawCount
  ;(b.onAfterRender as unknown as (...a: unknown[]) => void)(null, null, camera, b.geometry, b.material, null)
  return n
}
const lookingAt = (x: number, z: number) => {
  const c = new THREE.PerspectiveCamera(50, 1, 0.1, 3000)
  c.position.set(x, 40, z - 60); c.lookAt(x, 0, z)
  return c
}
const drawCount = (b: THREE.BatchedMesh) => (b as unknown as { _multiDrawCount: number })._multiDrawCount

describe('ChunkBatches own cull', () => {
  it('turns three\'s per-instance cull and sort off, and draws what is in view', () => {
    const b = batches()
    for (let cx = 0; cx < REGION; cx++) b.set(layout.chunkIndex(cx, 0, 0), cx, 0, 0, quads(1))
    const mesh = bm(b)[0]!
    expect(mesh.perObjectFrustumCulled).toBe(false)
    expect(mesh.sortObjects).toBe(false)
    b.beginFrame({ x: 16, y: 40, z: -44 }, Infinity)
    const n = render(mesh, lookingAt(16, 16))
    expect(n).toBeGreaterThan(0)
    expect(n).toBeLessThan(REGION + 1)
    expect(b.drawnCount).toBe(n)
  })
  it('skips chunks beyond the view distance and hides regions entirely beyond it', () => {
    const b = batches()
    b.set(layout.chunkIndex(0, 0, 0), 0, 0, 0, quads(1))
    b.set(layout.chunkIndex(REGION, 0, 0), REGION, 0, 0, quads(1))
    b.set(layout.chunkIndex(2, 0, 0), 2, 0, 0, quads(1)) // x 64–96: 48 from the eye, beyond 40
    b.beginFrame({ x: 16, y: 16, z: 16 }, 40)
    const [near, far] = bm(b)
    expect(near!.visible).toBe(true)
    expect(far!.visible).toBe(false) // region 1 starts at x 128: 112 > 40 away
    const top = new THREE.PerspectiveCamera(90, 1, 0.1, 3000)
    top.position.set(64, 300, 16); top.lookAt(64, 0, 16)
    expect(render(near!, top)).toBe(1) // chunk 2 is in the frustum but out of range
    b.beginFrame({ x: 16, y: 16, z: 16 }, Infinity)
    expect(far!.visible).toBe(true)
    expect(render(near!, top)).toBe(2)
  })
  it('leaves chunks above the layer cut out of the draw list until the cut is cleared, also at Infinity', () => {
    const b = batches(), cut = new LayerCut(layout)
    b.setCut(cut)
    b.set(layout.chunkIndex(0, 0, 0), 0, 0, 0, quads(1))
    b.set(layout.chunkIndex(0, 1, 0), 0, 1, 0, quads(1))
    const top = new THREE.PerspectiveCamera(90, 1, 0.1, 3000)
    top.position.set(16, 300, 16); top.lookAt(16, 0, 16)
    b.beginFrame({ x: 16, y: 16, z: 16 }, Infinity)
    const mesh = bm(b)[0]!
    expect(render(mesh, top)).toBe(2)
    cut.set(31)
    b.beginFrame({ x: 16, y: 16, z: 16 }, Infinity)
    expect(render(mesh, top)).toBe(1)
    cut.set(null)
    b.beginFrame({ x: 16, y: 16, z: 16 }, Infinity)
    expect(render(mesh, top)).toBe(2)
  })
  it('keeps three\'s cull with threeCull', () => {
    const b = new ChunkBatches(layout, new THREE.MeshBasicMaterial(), 'opaque', true, { threeCull: true })
    b.set(0, 0, 0, 0, quads(1))
    expect(bm(b)[0]!.perObjectFrustumCulled).toBe(true)
    expect(bm(b)[0]!.sortObjects).toBe(true)
  })
  it('restores the outer pass\'s list after a nested pass, and counts only the outer pass', () => {
    const b = batches()
    for (let cx = 0; cx < REGION; cx++) b.set(layout.chunkIndex(cx, 0, 0), cx, 0, 0, quads(1))
    const mesh = bm(b)[0]!
    b.beginFrame({ x: 16, y: 40, z: -44 }, Infinity)
    const main = lookingAt(16, 16), shadow = lookingAt(1000, 1000) // sees nothing of this region
    main.updateMatrixWorld(); shadow.updateMatrixWorld()
    const call = (f: unknown, c: THREE.Camera) => (f as (...a: unknown[]) => void)(null, null, c, mesh.geometry, mesh.material, null)
    call(mesh.onBeforeRender, main)
    const outer = drawCount(mesh)
    expect(outer).toBeGreaterThan(0)
    call(mesh.onBeforeRender, shadow)
    expect(drawCount(mesh)).toBe(0)
    call(mesh.onAfterRender, shadow) // the nested pass ends: main's list again
    expect(drawCount(mesh)).toBe(outer)
    call(mesh.onAfterRender, main)
    expect(b.drawnCount).toBe(outer)
  })
})

describe('PassGuard reset', () => {
  it('forgets a stack a throwing render left behind', () => {
    const g = new PassGuard()
    g.enter(new THREE.PerspectiveCamera()); g.enter(new THREE.PerspectiveCamera())
    expect(g.depth).toBe(2)
    g.reset()
    expect(g.depth).toBe(0)
    expect(g.exit()).toBeNull()
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
    for (const k of ['_indirectTexture', '_matricesTexture', '_geometryInfo', '_maxVertexCount', '_maxIndexCount', '_geometryInitialized', '_nextVertexStart', '_nextIndexStart',
      '_instanceInfo', '_multiDrawStarts', '_multiDrawCounts', '_multiDrawCount', '_multiDrawBytesPerElement', '_visibilityChanged']) expect(k in m, k).toBe(true)
  })
  it('the renderer still keeps its attribute store in _attributes, with a delete (Visuals frees replaced batch buffers through it)', async () => {
    const { default: Attributes } = await import('three/src/renderers/common/Attributes.js' as string) as { default: { prototype: object } }
    expect(typeof (Attributes.prototype as { delete?: unknown }).delete).toBe('function')
    const src = (THREE.WebGPURenderer as unknown as { toString(): string }).toString() + String(Object.getPrototypeOf(THREE.WebGPURenderer.prototype).constructor)
    expect(src).toContain('this._attributes = new Attributes')
  })
})
