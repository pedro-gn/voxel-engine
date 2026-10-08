import * as THREE from 'three/webgpu'
import type { LayerMesh } from '../mesh/quadBuilder.ts'
import type { Layout } from '../world/layout.ts'
import { geometryOf } from './chunkMeshes.ts'

/**
 * One chunk layer drawn by THREE.BatchedMesh: one batch per region of REGION × REGION chunk columns (all heights), so the
 * renderer pays its per-render-object CPU cost once per region instead of once per chunk. Each chunk is one geometry
 * plus one instance whose matrix is the chunk-centre translation; the chunk vertex shader reads that translation itself
 * (chunkVertex.ts `batchOffset`: three r186 applies the batch matrix before the material's positionNode, which then
 * overwrites it).
 *
 * three r186 traps handled here (re-check them on every three upgrade; the internals test pins the private fields):
 * 1. BatchedMesh._initializeGeometry builds the batch attributes from the first geometry but drops `gpuType` (IntType)
 *    and un-aliases `position` from `packed`: the batch geometry is pre-initialised instead (`newBatch`).
 * 2. setGeometrySize re-runs that initialisation, so growing goes through `growBatch`, which keeps both.
 * 3. The renderer's opaque/transparent sort reads geometry.boundingSphere and computes it from the integer `position`
 *    alias when missing (NaN radius errors): explicit region bounds go on the batch and on its geometry.
 * 4. The shadow map renders INSIDE the main pass, and both passes write the batch's single shared multi-draw list in
 *    onBeforeRender: `PassGuard` restores the outer camera's list after a nested pass.
 */

/** Chunk columns per region side. */
export const REGION = 4
/** Reserved space per chunk geometry, so most remeshes fit in place (setGeometryAt) instead of delete + append. */
const SLACK = 1.25
/** A batch that needs room compacts first when its freed (deleted, reserved) space passes this share of capacity. */
const COMPACT_AT = 0.3
/** Initial capacity per chunk slot of a batch; growth handles the rest, so memory scales with what is drawn. */
const VERTICES_PER_SLOT = 1024, INDICES_PER_SLOT = 1536

/** The BatchedMesh private state this module reads or writes (three r186). */
interface BatchInternals {
  _geometryInfo: { reservedVertexCount: number; reservedIndexCount: number }[]
  _maxVertexCount: number
  _maxIndexCount: number
  _nextVertexStart: number
  _nextIndexStart: number
  _geometryInitialized: boolean
  _visibilityChanged: boolean
}
const internals = (bm: THREE.BatchedMesh) => bm as unknown as BatchInternals

interface Entry { region: number; geometryId: number; instanceId: number }
interface Batch { mesh: THREE.BatchedMesh; freedVertices: number; freedIndices: number }

/** The packed vertex attribute, read as an integer vector in the shader (never converted to float). */
function packedAttribute(vertices: number): THREE.BufferAttribute {
  const packed = new THREE.BufferAttribute(new Uint32Array(vertices * 2), 2)
  packed.gpuType = THREE.IntType
  return packed
}

/** Trap 1: initialise the batch geometry ourselves, with the integer `packed` attribute aliased as `position`. */
function newBatch(material: THREE.Material, maxInstances: number, maxVertices: number, maxIndices: number): THREE.BatchedMesh {
  const bm = new THREE.BatchedMesh(maxInstances, maxVertices, maxIndices, material)
  const packed = packedAttribute(maxVertices)
  bm.geometry.setAttribute('packed', packed)
  bm.geometry.setAttribute('position', packed)
  bm.geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(maxIndices), 1))
  internals(bm)._geometryInitialized = true
  // `position` aliases the packed integers, so three's Raycaster would decode garbage triangles (picking goes through
  // engine.raycast).
  bm.raycast = () => {}
  return bm
}

/** Trap 2: grows a batch's vertex and index buffers, keeping `position` aliased to the integer `packed` attribute. */
function growBatch(bm: THREE.BatchedMesh, minVertices: number, minIndices: number): void {
  const b = internals(bm)
  const maxV = Math.max(minVertices, Math.ceil(b._maxVertexCount * 1.5))
  const maxI = Math.max(minIndices, Math.ceil(b._maxIndexCount * 1.5))
  const g = bm.geometry
  const packed = packedAttribute(maxV)
  ;(packed.array as Uint32Array).set((g.getAttribute('packed') as THREE.BufferAttribute).array as Uint32Array)
  const index = new THREE.BufferAttribute(new Uint32Array(maxI), 1)
  ;(index.array as Uint32Array).set(g.getIndex()!.array as Uint32Array)
  g.setAttribute('packed', packed)
  g.setAttribute('position', packed)
  g.setIndex(index)
  b._maxVertexCount = maxV
  b._maxIndexCount = maxI
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
}

type BeforeRender = (renderer: unknown, scene: unknown, camera: THREE.Camera, geometry: unknown, material: unknown, group: unknown) => void

function guardNestedPasses(bm: THREE.BatchedMesh): void {
  const guard = new PassGuard()
  const before = bm.onBeforeRender.bind(bm) as unknown as BeforeRender
  let lastGeometry: unknown = null, lastMaterial: unknown = null
  bm.onBeforeRender = ((renderer: unknown, scene: unknown, camera: THREE.Camera, geometry: unknown, material: unknown, group: unknown) => {
    guard.enter(camera)
    lastGeometry = geometry
    lastMaterial = material
    before(renderer, scene, camera, geometry, material, group)
  }) as unknown as typeof bm.onBeforeRender
  // three's onBeforeShadow re-runs onBeforeRender with the shadow camera, then the shadow pass's renderObject runs it
  // again with the same camera: a redundant cull + sort per batch per shadow pass, and it would unbalance the guard.
  bm.onBeforeShadow = () => {}
  bm.onAfterRender = ((renderer: unknown) => {
    const outer = guard.exit()
    if (!outer) return
    internals(bm)._visibilityChanged = true
    before(renderer, null, outer, lastGeometry, lastMaterial, null)
  }) as unknown as typeof bm.onAfterRender
}

export class ChunkBatches {
  readonly group = new THREE.Group()
  /** inPlace: remeshes written over their reserved space; appended: remeshes that outgrew it; grown / compacted: batches. */
  readonly stats = { inPlace: 0, appended: 0, grown: 0, compacted: 0 }
  private readonly batches = new Map<number, Batch>()
  private readonly entries = new Map<number, Entry>()
  private readonly matrix = new THREE.Matrix4()
  private readonly layout: Layout
  private material: THREE.Material
  private readonly name: string
  private readonly castShadow: boolean

  constructor(layout: Layout, material: THREE.Material, name: string, castShadow: boolean) {
    this.layout = layout
    this.material = material
    this.name = name
    this.castShadow = castShadow
    this.group.name = `elovox-chunks-${name}-batched`
  }

  /** Region batches (render objects). */
  get batchCount(): number { return this.batches.size }
  /** Chunks drawn (one instance each). */
  get instanceCount(): number { return this.entries.size }

  setMaterial(material: THREE.Material): void {
    this.material = material
    for (const b of this.batches.values()) b.mesh.material = material
  }

  set(ci: number, cx: number, cy: number, cz: number, lm: LayerMesh): void {
    const geometry = geometryOf(lm)
    const vertices = lm.vertices.length / 2, indices = lm.indices.length
    const e = this.entries.get(ci)
    if (e) {
      const batch = this.batches.get(e.region)!
      const info = internals(batch.mesh)._geometryInfo[e.geometryId]!
      if (vertices <= info.reservedVertexCount && indices <= info.reservedIndexCount) {
        batch.mesh.setGeometryAt(e.geometryId, geometry)
        this.stats.inPlace++
        return
      }
      this.free(batch, e)
      this.entries.delete(ci)
      this.stats.appended++
    }
    const region = Math.floor(cz / REGION) * 4096 + Math.floor(cx / REGION)
    const batch = this.batchFor(region, cx, cz)
    const bm = batch.mesh
    const rv = Math.ceil(vertices * SLACK), ri = Math.ceil(indices * SLACK)
    if (bm.unusedVertexCount < rv || bm.unusedIndexCount < ri) {
      const b = internals(bm)
      if (batch.freedVertices > COMPACT_AT * b._maxVertexCount || batch.freedIndices > COMPACT_AT * b._maxIndexCount) {
        bm.optimize()
        batch.freedVertices = 0
        batch.freedIndices = 0
        this.stats.compacted++
      }
      if (bm.unusedVertexCount < rv || bm.unusedIndexCount < ri) {
        growBatch(bm, b._nextVertexStart + rv, b._nextIndexStart + ri)
        this.stats.grown++
      }
    }
    const geometryId = bm.addGeometry(geometry, rv, ri)
    const instanceId = bm.addInstance(geometryId)
    bm.setMatrixAt(instanceId, this.matrix.makeTranslation(cx * 32 + 16, cy * 32 + 16, cz * 32 + 16))
    this.entries.set(ci, { region, geometryId, instanceId })
  }

  remove(ci: number): void {
    const e = this.entries.get(ci)
    if (!e) return
    this.free(this.batches.get(e.region)!, e)
    this.entries.delete(ci)
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
    const rw = Math.min(REGION, L.cx), rd = Math.min(REGION, L.cz)
    const maxInstances = rw * rd * L.cy
    const bm = newBatch(this.material, maxInstances, maxInstances * VERTICES_PER_SLOT, maxInstances * INDICES_PER_SLOT)
    bm.castShadow = this.castShadow
    bm.receiveShadow = true
    bm.name = `chunks-${this.name}-region-${region}`
    // Whole-batch culling uses the region's full box; per-chunk culling happens inside the batch, on the CPU.
    const x0 = Math.floor(cx / REGION) * REGION * 32, z0 = Math.floor(cz / REGION) * REGION * 32
    bm.boundingBox = new THREE.Box3(new THREE.Vector3(x0, 0, z0), new THREE.Vector3(x0 + rw * 32, L.cy * 32, z0 + rd * 32))
    bm.boundingSphere = bm.boundingBox.getBoundingSphere(new THREE.Sphere())
    // Trap 3: the renderer's sort reads geometry.boundingSphere (Renderer._projectObject), not the object's.
    bm.geometry.boundingBox = bm.boundingBox.clone()
    bm.geometry.boundingSphere = bm.boundingSphere.clone()
    bm.matrixAutoUpdate = false
    bm.updateMatrix()
    guardNestedPasses(bm)
    const batch: Batch = { mesh: bm, freedVertices: 0, freedIndices: 0 }
    this.batches.set(region, batch)
    this.group.add(bm)
    return batch
  }
}
