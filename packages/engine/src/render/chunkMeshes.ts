import * as THREE from 'three/webgpu'
import type { ChunkMeshData } from '../mesh/mesher.ts'
import type { LayerMesh } from '../mesh/quadBuilder.ts'
import type { Layout } from '../world/layout.ts'
import type { ChunkMaterials } from './materials.ts'

const LAYERS = ['opaque', 'cutout', 'translucent', 'liquid'] as const
const SPHERE = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 16 * Math.sqrt(3) + 0.5)

function geometryOf(m: LayerMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  const packed = new THREE.BufferAttribute(m.vertices, 2)
  packed.gpuType = THREE.IntType // integer attribute: read as uvec2 in the shader, never converted to float
  g.setAttribute('packed', packed)
  // three 0.186.1: node materials expect a `position` attribute and warn when it is missing.
  // Alias the same attribute object (no extra memory); the shader still reads `packed`.
  g.setAttribute('position', packed)
  g.setIndex(new THREE.BufferAttribute(m.indices, 1))
  g.boundingSphere = SPHERE.clone()
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-16, -16, -16), new THREE.Vector3(16, 16, 16))
  return g
}

export class ChunkMeshes {
  readonly group = new THREE.Group()
  private readonly layout: Layout
  private readonly owned: ChunkMaterials
  private readonly materials: Record<(typeof LAYERS)[number], THREE.Material>
  private readonly meshes = new Map<number, (THREE.Mesh | null)[]>()

  constructor(layout: Layout, materials: ChunkMaterials) {
    this.layout = layout
    this.owned = materials
    this.materials = { ...materials }
    this.group.name = 'elovox-chunks'
  }

  get meshCount(): number { return this.group.children.length }

  /** Chunk meshes that render into the sun's shadow map. */
  get shadowCasterCount(): number {
    let n = 0
    for (const m of this.group.children) if ((m as THREE.Mesh).castShadow) n++
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
      const existing = slots![k]!
      if (!lm) {
        if (existing) { this.group.remove(existing); existing.geometry.dispose(); slots![k] = null }
        return
      }
      const geo = geometryOf(lm)
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
      this.group.add(mesh)
      slots![k] = mesh
    })
  }

  remove(ci: number): void {
    const slots = this.meshes.get(ci)
    if (!slots) return
    for (const m of slots) if (m) { this.group.remove(m); m.geometry.dispose() }
    this.meshes.delete(ci)
  }

  dispose(): void {
    for (const ci of [...this.meshes.keys()]) this.remove(ci)
    for (const name of LAYERS) this.owned[name].dispose()
  }
}
