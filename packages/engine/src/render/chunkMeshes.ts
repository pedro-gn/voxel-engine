import * as THREE from 'three/webgpu'
import type { ChunkMeshData } from '../mesh/mesher.ts'
import type { LayerMesh } from '../mesh/quadBuilder.ts'
import type { Layout } from '../world/layout.ts'
import { CUTOUT_INDICES_PER_SLOT, CUTOUT_VERTICES_PER_SLOT, ChunkBatches } from './chunkBatches.ts'
import { chunkSphereRadius } from './chunkCull.ts'
import type { ChunkMaterials } from './materials.ts'
import type { LayerCut } from './layerCut.ts'
import { chunkInRange, type Vec3Like } from './viewDistance.ts'

export const LAYERS = ['opaque', 'cutout', 'translucent', 'liquid'] as const

/** `reach`: how far fringe strips poke out of the chunk, in blocks (BlockRegistry.fringeReach); the bounds grow by it. */
export function geometryOf(m: LayerMesh, reach = 0): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  const packed = new THREE.BufferAttribute(m.vertices, 2)
  packed.gpuType = THREE.IntType // integer attribute: read as uvec2 in the shader, never converted to float
  g.setAttribute('packed', packed)
  // three 0.186.1: node materials expect a `position` attribute and warn when it is missing.
  // Alias the same attribute object (no extra memory); the shader still reads `packed`.
  g.setAttribute('position', packed)
  g.setIndex(new THREE.BufferAttribute(m.indices, 1))
  const h = 16 + reach
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), chunkSphereRadius(reach))
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-h, -h, -h), new THREE.Vector3(h, h, h))
  return g
}

type Layer = (typeof LAYERS)[number]

export interface ChunkMeshesOptions {
  /** Draw the opaque and cutout layers in region batches (ChunkBatches) instead of one mesh per chunk. */
  batched?: boolean
  /** @internal three's own batch cull (the pixel-diff reference). */
  threeCull?: boolean
  /** Chunk columns per region batch side (ChunkBatches REGION by default). */
  region?: number
  /** How far fringe strips poke out of a chunk, in blocks (BlockRegistry.fringeReach); chunk and region bounds grow by it. Default 0. */
  fringeReach?: number
}

export class ChunkMeshes {
  readonly group = new THREE.Group()
  private readonly layout: Layout
  private readonly reach: number
  private readonly owned: ChunkMaterials
  private readonly materials: Record<Layer, THREE.Material>
  /** Per chunk, one mesh slot per layer; a batched layer's slot stays null. */
  private readonly meshes = new Map<number, (THREE.Mesh | null)[]>()
  private readonly batches: Partial<Record<Layer, ChunkBatches>> = {}
  private eye: Vec3Like = { x: 0, y: 0, z: 0 }
  private range = Infinity
  private cut: LayerCut | null = null
  /** The cut's y at the last visibility pass (undefined: never applied). */
  private cutY: number | null | undefined = null

  constructor(layout: Layout, materials: ChunkMaterials, { batched = false, threeCull = false, region, fringeReach = 0 }: ChunkMeshesOptions = {}) {
    this.layout = layout
    this.reach = fringeReach
    this.owned = materials
    this.materials = { ...materials }
    this.group.name = 'elovox-chunks'
    if (batched) {
      for (const name of ['opaque', 'cutout'] as const) {
        const b = new ChunkBatches(layout, this.materials[name], name, true, {
          threeCull, ...(region !== undefined && { region }), ...(fringeReach > 0 && { reach: fringeReach }),
          ...(name === 'cutout' && { verticesPerSlot: CUTOUT_VERTICES_PER_SLOT, indicesPerSlot: CUTOUT_INDICES_PER_SLOT }),
        })
        this.batches[name] = b
        this.group.add(b.group)
      }
    }
  }

  /** Chunk layer meshes: batch instances plus per-chunk meshes. */
  get meshCount(): number {
    let n = this.group.children.length // per-chunk meshes, plus one group per batched layer
    for (const b of Object.values(this.batches)) n += b.instanceCount - 1
    return n
  }

  /** Render objects that draw into the sun's shadow map: region batches plus per-chunk meshes. */
  get shadowCasterCount(): number {
    let n = 0
    for (const m of this.group.children) if ((m as THREE.Mesh).castShadow) n++ // a batched layer's group never casts
    for (const b of Object.values(this.batches)) n += b.batchCount
    return n
  }

  /** The layer cut (spec §4): chunks wholly above it are hidden. */
  setCut(cut: LayerCut | null): void {
    this.cut = cut
    for (const b of Object.values(this.batches)) b.setCut(cut)
  }

  /** Once per frame before rendering (Visuals.frame): the viewer and the view distance. */
  beginFrame(eye: Vec3Like, range: number): void {
    for (const b of Object.values(this.batches)) b.beginFrame(eye, range)
    const was = this.range, cutWas = this.cutY, cutY = this.cut?.y ?? null
    this.eye = { x: eye.x, y: eye.y, z: eye.z }
    this.range = range
    this.cutY = cutY
    // The default (no view distance, no cut, neither changed): every mesh stays visible, nothing to test.
    if (range === Infinity && was === Infinity && cutY === null && cutWas === null) return
    for (const [ci, slots] of this.meshes) {
      const on = this.shown(ci)
      for (const m of slots) if (m) m.visible = on
    }
  }

  private shown(ci: number): boolean { return this.inRange(ci) && !(this.cut?.hides(ci) ?? false) }

  private inRange(ci: number): boolean {
    const [cx, cy, cz] = this.layout.chunkCoords(ci)
    return chunkInRange(this.eye, this.range, cx * 32 + 16, cy * 32 + 16, cz * 32 + 16)
  }

  /** Bytes reserved by the region batches (ChunkBatches.capacityBytes). */
  get batchBytes(): number {
    let n = 0
    for (const b of Object.values(this.batches)) n += b.capacityBytes
    return n
  }

  /** Frees the GPU buffers batch grows replaced (ChunkBatches.releaseRetired); call after a render. */
  releaseRetired(free: (attribute: THREE.BufferAttribute) => void): void {
    for (const b of Object.values(this.batches)) b.releaseRetired(free)
  }

  /** Chunk layer draws of the camera's pass this frame: batched chunks after the cull, plus per-chunk meshes in range. */
  get drawnCount(): number {
    let n = 0
    for (const b of Object.values(this.batches)) n += b.drawnCount
    for (const m of this.group.children) if ((m as THREE.Mesh).isMesh && m.visible) n++
    return n
  }

  /** The material this layer was constructed with. */
  baseMaterial(layer: (typeof LAYERS)[number]): THREE.Material { return this.owned[layer] }

  /** Swaps the material of every mesh in one layer (water on/off). */
  setLayerMaterial(layer: 'liquid', material: THREE.Material): void {
    this.materials[layer] = material
    for (const slots of this.meshes.values()) {
      const m = slots[LAYERS.indexOf(layer)]
      if (m) m.material = material
    }
  }

  apply(ci: number, data: ChunkMeshData): void {
    let slots = this.meshes.get(ci)
    if (!slots) { slots = [null, null, null, null]; this.meshes.set(ci, slots) }
    const [cx, cy, cz] = this.layout.chunkCoords(ci)
    LAYERS.forEach((name, k) => {
      const lm = data[name]
      const batches = this.batches[name]
      if (batches) {
        if (lm) batches.set(ci, cx, cy, cz, lm)
        else batches.remove(ci)
        return
      }
      const existing = slots![k]!
      if (!lm) {
        if (existing) { this.group.remove(existing); existing.geometry.dispose(); slots![k] = null }
        return
      }
      const geo = geometryOf(lm, this.reach)
      if (existing) {
        existing.geometry.dispose()
        existing.geometry = geo
        return
      }
      const mesh = new THREE.Mesh(geo, this.materials[name])
      // `position` aliases the packed uint attribute, so three's Raycaster would decode garbage triangles.
      // Voxel picking goes through engine.raycast instead; keep chunk meshes out of scene raycasts.
      mesh.raycast = () => {}
      mesh.castShadow = name === 'opaque' || name === 'cutout'
      mesh.receiveShadow = true
      if (name === 'liquid') mesh.renderOrder = 1 // draw after glass
      mesh.position.set(cx * 32 + 16, cy * 32 + 16, cz * 32 + 16)
      mesh.matrixAutoUpdate = false
      mesh.updateMatrix()
      mesh.name = `chunk-${ci}-${name}`
      mesh.visible = this.shown(ci)
      this.group.add(mesh)
      slots![k] = mesh
    })
  }

  remove(ci: number): void {
    for (const b of Object.values(this.batches)) b.remove(ci)
    const slots = this.meshes.get(ci)
    if (!slots) return
    for (const m of slots) if (m) { this.group.remove(m); m.geometry.dispose() }
    this.meshes.delete(ci)
  }

  dispose(): void {
    for (const ci of [...this.meshes.keys()]) this.remove(ci)
    for (const b of Object.values(this.batches)) { this.group.remove(b.group); b.dispose() }
    for (const name of LAYERS) this.owned[name].dispose()
  }
}
