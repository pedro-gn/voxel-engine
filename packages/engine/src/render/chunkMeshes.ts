import * as THREE from 'three/webgpu'
import type { ChunkMeshData } from '../mesh/mesher.ts'
import type { LayerMesh } from '../mesh/quadBuilder.ts'
import type { Layout } from '../world/layout.ts'
import type { ChunkMaterials } from './materials.ts'

const LAYERS = ['opaque', 'cutout', 'translucent'] as const
const SPHERE = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 16 * Math.sqrt(3) + 0.5)

function geometryOf(m: LayerMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  const packed = new THREE.BufferAttribute(m.vertices, 2)
  packed.gpuType = THREE.IntType // integer attribute: read as uvec2 in the shader, never converted to float
  g.setAttribute('packed', packed)
  g.setIndex(new THREE.BufferAttribute(m.indices, 1))
  g.boundingSphere = SPHERE.clone()
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-16, -16, -16), new THREE.Vector3(16, 16, 16))
  return g
}

export class ChunkMeshes {
  readonly group = new THREE.Group()
  private readonly layout: Layout
  private readonly materials: ChunkMaterials
  private readonly meshes = new Map<number, (THREE.Mesh | null)[]>()

  constructor(layout: Layout, materials: ChunkMaterials) {
    this.layout = layout
    this.materials = materials
    this.group.name = 'elovox-chunks'
  }

  get meshCount(): number { return this.group.children.length }

  apply(ci: number, data: ChunkMeshData): void {
    let slots = this.meshes.get(ci)
    if (!slots) { slots = [null, null, null]; this.meshes.set(ci, slots) }
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
    for (const name of LAYERS) this.materials[name].dispose()
  }
}
