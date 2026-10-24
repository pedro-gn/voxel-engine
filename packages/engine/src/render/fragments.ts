import * as THREE from 'three/webgpu'
import { attribute, float, normalLocal, texture, varying, vec4 } from 'three/tsl'
import type { BlockRegistry } from '../blocks/registry.ts'
import type { Layout } from '../world/layout.ts'
import { fragmentGeometry } from './fragmentGeometry.ts'
import { belowCut } from './layerCut.ts'
import type { FragmentFrame } from './fragmentTrack.ts'
import { VoxelNodeMaterial, voxelLit, type LightUniforms } from './voxelLighting.ts'

/** Exposed geometry is static; frame work changes one transform per fragment. */
export class FragmentMeshes {
  readonly group = new THREE.Group()
  private readonly bodies = new Map<number, THREE.Group>()
  private readonly materials = new Map<number, VoxelNodeMaterial>()
  private readonly layout: Layout
  private readonly registry: BlockRegistry
  private readonly faceLayers: Uint16Array
  constructor(layout: Layout, registry: BlockRegistry, faceLayers: Uint16Array, tex: THREE.DataArrayTexture, lights: LightUniforms) {
    this.layout = layout; this.registry = registry; this.faceLayers = faceLayers; this.group.name = 'elovox-fragments'
    for (const layer of [1, 2, 3]) {
      const info = attribute('fragmentInfo', 'vec3'), sky = varying(info.y.div(15)), blk = varying(info.z.div(15)), slice = varying(info.x)
      const m = new VoxelNodeMaterial(sky), albedo = texture(tex, attribute('uv', 'vec2')).depth(slice.add(0.5).toInt())
      voxelLit(m, { normal: normalLocal, sky, blk, ao: float(1), albedo: albedo.rgb }, lights)
      m.colorNode = layer === 1 ? vec4(albedo.rgb, 1) : albedo
      if (layer === 2) { m.alphaTest = 0.5; m.side = THREE.DoubleSide }
      if (layer === 3) { m.transparent = true; m.depthWrite = false }
      m.maskNode = belowCut() // the layer cut hides fragments above it (spec §4)
      m.shadowSide = THREE.FrontSide; this.materials.set(layer, m)
    }
  }
  set(frames: readonly FragmentFrame[], light: (x: number, y: number, z: number) => number): void {
    const seen = new Set<number>()
    for (const frame of frames) {
      const id = frame.birth.id; seen.add(id)
      let group = this.bodies.get(id)
      if (!group) {
        group = new THREE.Group(); group.name = `fragment-${id}`
        // Fragments draw a block's plain face layers: a tone block (BlockDef.tone) bursts untinted and without fringe.
        for (const data of fragmentGeometry(frame.birth, this.layout, this.registry, this.faceLayers, light)) {
          const g = new THREE.BufferGeometry()
          g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3)); g.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3))
          g.setAttribute('uv', new THREE.BufferAttribute(data.uv, 2)); g.setAttribute('fragmentInfo', new THREE.BufferAttribute(data.info, 3))
          g.setIndex(new THREE.BufferAttribute(data.indices, 1)); g.computeBoundingBox(); g.computeBoundingSphere()
          const mesh = new THREE.Mesh(g, this.materials.get(data.layer)!); mesh.castShadow = data.layer !== 3; mesh.receiveShadow = true; mesh.raycast = () => {}
          group.add(mesh)
        }
        this.bodies.set(id, group); this.group.add(group)
      }
      group.position.y = frame.offset
    }
    for (const [id, group] of this.bodies) if (!seen.has(id)) { this.group.remove(group); for (const mesh of group.children) (mesh as THREE.Mesh).geometry.dispose(); this.bodies.delete(id) }
  }
  dispose(): void { this.set([], () => 0); for (const m of this.materials.values()) m.dispose() }
}
