import * as THREE from 'three/webgpu'
import type { Layout } from '../../world/layout.ts'
import { selectVisible, type DecorationChunk } from './budget.ts'
import { flowerArrays, tuftArrays, type DecorationArrays } from './shapes.ts'

const SPHERE_R = 16 * Math.sqrt(3) + 2.5

function baseGeometry(a: DecorationArrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(a.position, 3))
  g.setAttribute('info', new THREE.BufferAttribute(a.info, 4))
  g.setIndex(new THREE.BufferAttribute(a.index, 1))
  return g
}

interface Entry { grass: THREE.Mesh | null; flowers: THREE.Mesh | null; count: number; centre: THREE.Vector3 }

/** Per-chunk instanced grass and flowers, culled by distance and an instance ceiling. */
export class DecorationMeshes {
  readonly group = new THREE.Group()
  private readonly layout: Layout
  private readonly materials: { grass: THREE.Material; flowers: THREE.Material }
  private readonly tuft = baseGeometry(tuftArrays())
  private readonly flower = baseGeometry(flowerArrays())
  private readonly entries = new Map<number, Entry>()

  constructor(layout: Layout, materials: { grass: THREE.Material; flowers: THREE.Material }) {
    this.layout = layout
    this.materials = materials
    this.group.name = 'elovox-decorations'
  }

  apply(ci: number, grass: Uint32Array | null, flowers: Uint32Array | null): void {
    this.remove(ci)
    if (!grass && !flowers) return
    const [cx, cy, cz] = this.layout.chunkCoords(ci)
    const e: Entry = {
      grass: grass ? this.mesh(grass, this.tuft, this.materials.grass, cx, cy, cz) : null,
      flowers: flowers ? this.mesh(flowers, this.flower, this.materials.flowers, cx, cy, cz) : null,
      count: (grass?.length ?? 0) / 2 + (flowers?.length ?? 0) / 2,
      centre: new THREE.Vector3(cx * 32 + 16, cy * 32 + 16, cz * 32 + 16),
    }
    this.entries.set(ci, e)
  }

  remove(ci: number): void {
    const e = this.entries.get(ci)
    if (!e) return
    for (const m of [e.grass, e.flowers]) {
      if (!m) continue
      this.group.remove(m)
      // Disposing releases the shared base attributes too; three re-uploads them (a few KB) on next use.
      m.geometry.dispose()
    }
    this.entries.delete(ci)
  }

  cull(camera: THREE.Vector3, radius: number, maxInstances: number): { instances: number; draws: number } {
    const list: DecorationChunk[] = []
    for (const [ci, e] of this.entries) list.push({ ci, dist: Math.hypot(e.centre.x - camera.x, e.centre.z - camera.z), count: e.count })
    const show = selectVisible(list, radius, maxInstances)
    let instances = 0, draws = 0
    for (const [ci, e] of this.entries) {
      const on = show.has(ci)
      for (const m of [e.grass, e.flowers]) if (m) { m.visible = on; if (on) draws++ }
      if (on) instances += e.count
    }
    return { instances, draws }
  }

  dispose(): void {
    for (const ci of [...this.entries.keys()]) this.remove(ci)
    this.tuft.dispose()
    this.flower.dispose()
    this.materials.grass.dispose()
    this.materials.flowers.dispose()
  }

  private mesh(data: Uint32Array, base: THREE.BufferGeometry, material: THREE.Material, cx: number, cy: number, cz: number): THREE.Mesh {
    const g = new THREE.InstancedBufferGeometry()
    g.index = base.index
    g.setAttribute('position', base.getAttribute('position'))
    g.setAttribute('info', base.getAttribute('info'))
    const inst = new THREE.InstancedBufferAttribute(data, 2)
    inst.gpuType = THREE.IntType // read as uvec2 in the shader (spike P4)
    g.setAttribute('inst', inst)
    g.instanceCount = data.length / 2
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(16, 16, 16), SPHERE_R)
    const m = new THREE.Mesh(g, material)
    m.position.set(cx * 32, cy * 32, cz * 32)
    m.matrixAutoUpdate = false
    m.updateMatrix()
    m.raycast = () => {}
    m.castShadow = false
    m.receiveShadow = true
    m.name = `deco-${cx}-${cy}-${cz}`
    this.group.add(m)
    return m
  }
}
