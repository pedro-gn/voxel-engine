import * as THREE from 'three/webgpu'
import type { LayerMesh } from '../mesh/quadBuilder.ts'
import type { Layout } from '../world/layout.ts'
import { buildDrawList, chunkSphereRadius, frustumPlanes, type GeometryRecord, type InstanceRecord } from './chunkCull.ts'
import { geometryOf } from './chunkMeshes.ts'
import type { LayerCut } from './layerCut.ts'
import { boxInRange, type Vec3Like } from './viewDistance.ts'

/**
 * One chunk layer drawn by THREE.BatchedMesh: one batch per region of REGION × REGION chunk columns (all heights), so the
 * renderer pays its per-render-object CPU cost once per region instead of once per chunk. Each chunk is one geometry
 * plus one instance whose matrix is the chunk-centre translation.
 *
 * The four three r186 traps (re-check them on every three upgrade; the internals test pins the private fields):
 * 1. Custom position: the batch matrix is applied to positionLocal before the material's positionNode, which then
 *    overwrites it. Handled in chunkVertex.ts (`batchOffset`), which reads the instance translation itself.
 * 2. Batch geometry: BatchedMesh._initializeGeometry (and setGeometrySize, which re-runs it) builds the batch attributes
 *    from a geometry but drops `gpuType` (IntType) and un-aliases `position` from `packed`. The batch geometry is built
 *    here instead (`newBatch`) and grown here (`growBatch`).
 * 3. Bounds: the renderer's opaque/transparent sort reads geometry.boundingSphere and computes it from the integer
 *    `position` alias when missing (NaN radius errors). Explicit region bounds go on the batch and its geometry.
 * 4. Nested shadow pass: the shadow map renders INSIDE the main pass, and both passes write the batch's single shared
 *    multi-draw list in onBeforeRender. `PassGuard` restores the outer camera's list after a nested pass, and the
 *    duplicate cull of onBeforeShadow is skipped.
 *
 * The cull itself is the engine's (chunkCull.ts, spec 4b §4.1): per pass, a world-space frustum test of precomputed chunk
 * spheres plus the view distance, with no sort. three's own per-instance cull and sort stay available as `threeCull`,
 * the pixel-diff reference.
 */

/**
 * Chunk columns per region side. 8, measured against 4 at 1024² (spec 4b §4.2, window-4 re-A/B): terrain CPU per frame
 * falls by about 2 ms at the far and ground poses, edit latency in wall ms is no worse, and batch memory rises 3.5-8%.
 */
export const REGION = 8
/** Reserved space per chunk geometry, so most remeshes fit in place (setGeometryAt) instead of delete + append. */
const SLACK = 1.25
/** A batch that needs room compacts first when its freed (deleted, reserved) space passes this share of capacity. */
const COMPACT_AT = 0.3
/** Initial capacity per chunk slot of a batch; growth handles the rest, so memory scales with what is drawn. */
const VERTICES_PER_SLOT = 1024, INDICES_PER_SLOT = 1536
/**
 * The cutout layer's initial capacity per slot. Measured at 1024² (spec 4b §4.2): the showcase's cutout chunks reserve
 * 278 vertices per slot on average (925,700 over 52 batches × 64 slots), the default world none. The smallest power of
 * two ≥ 1.25 × 278 halves the cutout batches' initial memory; growth handles a dense forest.
 */
export const CUTOUT_VERTICES_PER_SLOT = 512, CUTOUT_INDICES_PER_SLOT = 768

/** The BatchedMesh private state this module reads or writes (three r186). */
interface BatchInternals {
  _geometryInfo: (GeometryRecord & { reservedVertexCount: number; reservedIndexCount: number })[]
  _instanceInfo: InstanceRecord[]
  _multiDrawStarts: Int32Array
  _multiDrawCounts: Int32Array
  _multiDrawCount: number
  _multiDrawBytesPerElement: number
  _indirectTexture: THREE.DataTexture
  _maxVertexCount: number
  _maxIndexCount: number
  _nextVertexStart: number
  _nextIndexStart: number
  _geometryInitialized: boolean
  _visibilityChanged: boolean
}
const internals = (bm: THREE.BatchedMesh) => bm as unknown as BatchInternals

interface Entry { region: number; geometryId: number; instanceId: number }
interface Batch {
  mesh: THREE.BatchedMesh
  freedVertices: number
  freedIndices: number
  /** Per instance id: the chunk's centre (x, y, z). Chunks never move, so the cull needs no matrix per pass. */
  centres: Float32Array
  guard: PassGuard
  /** Chunk draws of the camera's (outermost) pass this frame. */
  drawn: number
  /** The region's box, for the view distance. */
  box: THREE.Box3
}

export interface ChunkBatchOptions {
  /** @internal three's own per-instance cull and sort (the pixel-diff reference) instead of the engine's. Default false. */
  threeCull?: boolean
  /** Chunk columns per region side. Default REGION. */
  region?: number
  /** Initial vertex and index capacity per chunk slot. Default VERTICES_PER_SLOT / INDICES_PER_SLOT. */
  verticesPerSlot?: number
  indicesPerSlot?: number
  /** How far fringe strips poke out of a chunk, in blocks (BlockRegistry.fringeReach): chunk spheres and region boxes grow by it. Default 0. */
  reach?: number
}

/** The packed vertex attribute, read as an integer vector in the shader (never converted to float). */
function packedAttribute(vertices: number): THREE.BufferAttribute {
  const packed = new THREE.BufferAttribute(new Uint32Array(vertices * 2), 2)
  packed.gpuType = THREE.IntType
  return packed
}

/**
 * Names that alias the integer `packed` attribute (no extra memory). `position`: node materials expect one. `normal`:
 * three's batch node transforms normalLocal, which warns ("Vertex attribute "normal" not found") without one; the chunk
 * material computes its own normal, so the alias is never read as a normal.
 */
const ALIASES = ['position', 'normal'] as const

/** Trap 2: initialise the batch geometry ourselves, with the integer `packed` attribute aliased as `position` and `normal`. */
function newBatch(material: THREE.Material, maxInstances: number, maxVertices: number, maxIndices: number): THREE.BatchedMesh {
  const bm = new THREE.BatchedMesh(maxInstances, maxVertices, maxIndices, material)
  const packed = packedAttribute(maxVertices)
  bm.geometry.setAttribute('packed', packed)
  for (const name of ALIASES) bm.geometry.setAttribute(name, packed)
  bm.geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(maxIndices), 1))
  internals(bm)._geometryInitialized = true
  // `position` aliases the packed integers, so three's Raycaster would decode garbage triangles (picking goes through
  // engine.raycast).
  bm.raycast = () => {}
  return bm
}

/**
 * Trap 2, again: three iterates the batch geometry's attributes BY NAME when it copies vertex data (setGeometryAt) and
 * when it compacts (optimize), so each alias of `packed` gets every copy again. In optimize, a geometry that moves by
 * less than its reserved size then reads ranges the first copy already overwrote, which corrupts its vertices. Runs `fn`
 * with the aliases removed, so each copy happens once.
 */
function unaliased<T>(bm: THREE.BatchedMesh, fn: () => T): T {
  const g = bm.geometry
  const packed = g.getAttribute('packed')
  for (const name of ALIASES) g.deleteAttribute(name)
  try { return fn() } finally { for (const name of ALIASES) g.setAttribute(name, packed) }
}

/**
 * Trap 2: grows a batch's vertex and index buffers, keeping the aliases on the integer `packed` attribute. Returns the
 * replaced attributes, whose GPU buffers the renderer keeps until they are deleted (ChunkBatches.releaseRetired).
 */
function growBatch(bm: THREE.BatchedMesh, minVertices: number, minIndices: number): THREE.BufferAttribute[] {
  const b = internals(bm)
  const maxV = Math.max(minVertices, Math.ceil(b._maxVertexCount * 1.5))
  const maxI = Math.max(minIndices, Math.ceil(b._maxIndexCount * 1.5))
  const g = bm.geometry
  const oldPacked = g.getAttribute('packed') as THREE.BufferAttribute, oldIndex = g.getIndex()!
  const packed = packedAttribute(maxV)
  ;(packed.array as Uint32Array).set(oldPacked.array as Uint32Array)
  const index = new THREE.BufferAttribute(new Uint32Array(maxI), 1)
  ;(index.array as Uint32Array).set(oldIndex.array as Uint32Array)
  g.setAttribute('packed', packed)
  for (const name of ALIASES) g.setAttribute(name, packed)
  g.setIndex(index)
  b._maxVertexCount = maxV
  b._maxIndexCount = maxI
  return [oldPacked, oldIndex]
}

/**
 * Trap 4: the cameras of the passes currently drawing one batch. The shadow map renders inside the main pass
 * (ShadowNode.updateBefore of the first shadow-receiving render object), and every pass rewrites the batch's single
 * multi-draw list in onBeforeRender. When a nested pass ends, the outer pass's list must be rebuilt.
 */
export class PassGuard {
  private readonly stack: THREE.Camera[] = []

  enter(camera: THREE.Camera): void { this.stack.push(camera) }

  /** Ends the innermost pass; returns the camera of the pass it was nested in, or null after the outermost. */
  exit(): THREE.Camera | null {
    this.stack.pop()
    return this.stack[this.stack.length - 1] ?? null
  }

  /** Passes currently open. */
  get depth(): number { return this.stack.length }

  /** Drops the stack: called at the start of a frame, so a render that threw cannot leave a stale outer pass. */
  reset(): void { this.stack.length = 0 }
}

type BeforeRender = (renderer: unknown, scene: unknown, camera: THREE.Camera, geometry: unknown, material: unknown, group: unknown) => void

export class ChunkBatches {
  readonly group = new THREE.Group()
  /** inPlace: remeshes written over their reserved space; appended: remeshes that outgrew it; grown / compacted: batches. */
  readonly stats = { inPlace: 0, appended: 0, grown: 0, compacted: 0 }
  private readonly batches = new Map<number, Batch>()
  private readonly entries = new Map<number, Entry>()
  private readonly matrix = new THREE.Matrix4()
  private readonly layout: Layout
  private readonly material: THREE.Material
  /** Attributes replaced by grows, until releaseRetired frees their GPU buffers. */
  private readonly retired: THREE.BufferAttribute[] = []
  private readonly name: string
  private readonly castShadow: boolean
  private readonly threeCull: boolean
  private readonly region: number
  private readonly verticesPerSlot: number
  private readonly indicesPerSlot: number
  private readonly reach: number
  private readonly radius: number
  private readonly frustum = new THREE.Frustum()
  private readonly projView = new THREE.Matrix4()
  private readonly planes = new Float64Array(24)
  private eye: Vec3Like = { x: 0, y: 0, z: 0 }
  private range = Infinity
  private cut: LayerCut | null = null

  constructor(layout: Layout, material: THREE.Material, name: string, castShadow: boolean, options: ChunkBatchOptions = {}) {
    this.layout = layout
    this.material = material
    this.name = name
    this.castShadow = castShadow
    this.threeCull = options.threeCull ?? false
    this.region = options.region ?? REGION
    this.verticesPerSlot = options.verticesPerSlot ?? VERTICES_PER_SLOT
    this.indicesPerSlot = options.indicesPerSlot ?? INDICES_PER_SLOT
    this.reach = options.reach ?? 0
    this.radius = chunkSphereRadius(this.reach)
    this.group.name = `elovox-chunks-${name}-batched`
  }

  /** Region batches (render objects). */
  get batchCount(): number { return this.batches.size }
  /** Chunks drawn (one instance each). */
  get instanceCount(): number { return this.entries.size }
  /** Bytes the batches reserve: packed vertices (8 each) plus indices (4 each), CPU side; the GPU buffers mirror them. */
  get capacityBytes(): number {
    let n = 0
    for (const b of this.batches.values()) { const i = internals(b.mesh); n += i._maxVertexCount * 8 + i._maxIndexCount * 4 }
    return n
  }

  /**
   * Hands every vertex and index attribute a grow replaced to `free` (the renderer's attribute delete), once. Call after a
   * render: that render already drew from the new buffers, so the old ones are unused.
   */
  releaseRetired(free: (attribute: THREE.BufferAttribute) => void): void {
    for (const a of this.retired) free(a)
    this.retired.length = 0
  }

  set(ci: number, cx: number, cy: number, cz: number, lm: LayerMesh): void {
    const geometry = geometryOf(lm, this.reach)
    const vertices = lm.vertices.length / 2, indices = lm.indices.length
    const e = this.entries.get(ci)
    if (e) {
      const batch = this.batches.get(e.region)!
      const info = internals(batch.mesh)._geometryInfo[e.geometryId]!
      if (vertices <= info.reservedVertexCount && indices <= info.reservedIndexCount) {
        unaliased(batch.mesh, () => batch.mesh.setGeometryAt(e.geometryId, geometry))
        this.stats.inPlace++
        return
      }
      this.free(batch, e)
      this.entries.delete(ci)
      this.stats.appended++
    }
    const region = Math.floor(cz / this.region) * 4096 + Math.floor(cx / this.region)
    const batch = this.batchFor(region, cx, cz)
    const bm = batch.mesh
    const rv = Math.ceil(vertices * SLACK), ri = Math.ceil(indices * SLACK)
    if (bm.unusedVertexCount < rv || bm.unusedIndexCount < ri) {
      const b = internals(bm)
      if (batch.freedVertices > COMPACT_AT * b._maxVertexCount || batch.freedIndices > COMPACT_AT * b._maxIndexCount) {
        unaliased(bm, () => bm.optimize())
        batch.freedVertices = 0
        batch.freedIndices = 0
        this.stats.compacted++
      }
      if (bm.unusedVertexCount < rv || bm.unusedIndexCount < ri) {
        this.retired.push(...growBatch(bm, b._nextVertexStart + rv, b._nextIndexStart + ri))
        this.stats.grown++
      }
    }
    const geometryId = unaliased(bm, () => bm.addGeometry(geometry, rv, ri))
    const instanceId = bm.addInstance(geometryId)
    bm.setMatrixAt(instanceId, this.matrix.makeTranslation(cx * 32 + 16, cy * 32 + 16, cz * 32 + 16))
    batch.centres[instanceId * 3] = cx * 32 + 16
    batch.centres[instanceId * 3 + 1] = cy * 32 + 16
    batch.centres[instanceId * 3 + 2] = cz * 32 + 16
    this.entries.set(ci, { region, geometryId, instanceId })
  }

  remove(ci: number): void {
    const e = this.entries.get(ci)
    if (!e) return
    this.free(this.batches.get(e.region)!, e)
    this.entries.delete(ci)
  }

  /** The layer cut: chunks wholly above it leave the draw list (the engine's cull; `threeCull` ignores it). */
  setCut(cut: LayerCut | null): void { this.cut = cut }

  /** Once per frame before rendering: the viewer and the view distance; resets the per-frame counts and pass guards. */
  beginFrame(eye: Vec3Like, range: number): void {
    this.eye = { x: eye.x, y: eye.y, z: eye.z }
    this.range = range
    for (const b of this.batches.values()) {
      b.guard.reset()
      b.drawn = 0
      const { min, max } = b.box
      b.mesh.visible = boxInRange(this.eye, range, min.x, min.y, min.z, max.x, max.y, max.z)
    }
  }

  /** Chunk draws of the camera's pass in the current frame (after the frustum and view-distance cull). */
  get drawnCount(): number {
    let n = 0
    for (const b of this.batches.values()) if (b.mesh.visible) n += b.drawn
    return n
  }

  dispose(): void {
    for (const b of this.batches.values()) { this.group.remove(b.mesh); b.mesh.dispose() }
    this.batches.clear()
    this.entries.clear()
  }

  /** Deletes a chunk's geometry (and its instance) and counts its reserved space as freed. */
  private free(batch: Batch, e: Entry): void {
    const info = internals(batch.mesh)._geometryInfo[e.geometryId]!
    batch.freedVertices += info.reservedVertexCount
    batch.freedIndices += info.reservedIndexCount
    batch.mesh.deleteGeometry(e.geometryId)
  }

  private batchFor(region: number, cx: number, cz: number): Batch {
    const existing = this.batches.get(region)
    if (existing) return existing
    const L = this.layout
    const rw = Math.min(this.region, L.cx), rd = Math.min(this.region, L.cz)
    const maxInstances = rw * rd * L.cy
    const bm = newBatch(this.material, maxInstances, maxInstances * this.verticesPerSlot, maxInstances * this.indicesPerSlot)
    if (!this.threeCull) {
      bm.perObjectFrustumCulled = false
      bm.sortObjects = false
    }
    bm.castShadow = this.castShadow
    bm.receiveShadow = true
    bm.name = `chunks-${this.name}-region-${region}`
    // Whole-batch culling uses the region's full box; per-chunk culling happens inside the batch, on the CPU.
    const x0 = Math.floor(cx / this.region) * this.region * 32, z0 = Math.floor(cz / this.region) * this.region * 32
    bm.boundingBox = new THREE.Box3(new THREE.Vector3(x0, 0, z0), new THREE.Vector3(x0 + rw * 32, L.cy * 32, z0 + rd * 32))
    if (this.reach > 0) bm.boundingBox.expandByScalar(this.reach) // fringe strips poke out of the region's chunks
    bm.boundingSphere = bm.boundingBox.getBoundingSphere(new THREE.Sphere())
    // Trap 3: the renderer's sort reads geometry.boundingSphere (Renderer._projectObject), not the object's.
    bm.geometry.boundingBox = bm.boundingBox.clone()
    bm.geometry.boundingSphere = bm.boundingSphere.clone()
    bm.matrixAutoUpdate = false
    bm.updateMatrix()
    const batch: Batch = {
      mesh: bm, freedVertices: 0, freedIndices: 0, centres: new Float32Array(maxInstances * 3), guard: new PassGuard(), drawn: 0,
      box: bm.boundingBox.clone(),
    }
    this.wire(batch)
    bm.visible = boxInRange(this.eye, this.range, x0, 0, z0, x0 + rw * 32, L.cy * 32, z0 + rd * 32)
    this.batches.set(region, batch)
    this.group.add(bm)
    return batch
  }

  /** Trap 4: every pass culls into the batch's single list; after a nested pass the outer camera's list is rebuilt. */
  private wire(batch: Batch): void {
    const bm = batch.mesh, guard = batch.guard
    const three = bm.onBeforeRender.bind(bm) as unknown as BeforeRender
    const before: BeforeRender = this.threeCull ? three : (_renderer, _scene, camera) => this.cull(batch, camera)
    let lastGeometry: unknown = null, lastMaterial: unknown = null
    bm.onBeforeRender = ((renderer: unknown, scene: unknown, camera: THREE.Camera, geometry: unknown, material: unknown, group: unknown) => {
      guard.enter(camera)
      lastGeometry = geometry
      lastMaterial = material
      before(renderer, scene, camera, geometry, material, group)
    }) as unknown as typeof bm.onBeforeRender
    // three's onBeforeShadow re-runs onBeforeRender with the shadow camera, then the shadow pass's renderObject runs it
    // again with the same camera: a redundant cull per batch per shadow pass, and it would unbalance the guard.
    bm.onBeforeShadow = () => {}
    bm.onAfterRender = ((renderer: unknown) => {
      const outer = guard.exit()
      if (!outer) return
      internals(bm)._visibilityChanged = true
      before(renderer, null, outer, lastGeometry, lastMaterial, null)
    }) as unknown as typeof bm.onAfterRender
  }

  /** The engine's cull (spec 4b §4.1): world-space frustum of the pass camera, precomputed chunk spheres, view distance, no sort. */
  private cull(batch: Batch, camera: THREE.Camera): void {
    const b = internals(batch.mesh)
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.projView, camera.coordinateSystem, (camera as { reversedDepth?: boolean }).reversedDepth ?? false)
    frustumPlanes(this.frustum, this.planes)
    const n = buildDrawList(b._instanceInfo, b._geometryInfo, batch.centres, this.planes, this.eye, this.range, 4,
      b._multiDrawStarts, b._multiDrawCounts, b._indirectTexture.image.data as unknown as Uint32Array, this.cut?.top ?? Infinity, this.radius)
    b._multiDrawCount = n
    b._multiDrawBytesPerElement = 4 // the batch index is a Uint32Array (newBatch)
    b._indirectTexture.needsUpdate = true
    b._visibilityChanged = false
    if (batch.guard.depth === 1) batch.drawn = n // the outermost pass is the camera's
  }
}
