import * as THREE from 'three/webgpu'
import { attribute, float, normalLocal, positionLocal, select, texture, varying, vec4 } from 'three/tsl'
import { cubeLight, type FallingCube } from './fallingTrack.ts'
import { belowCut } from './layerCut.ts'
import { VoxelNodeMaterial, voxelLit, type LightUniforms } from './voxelLighting.ts'

/** Falling blocks as instanced unit cubes: per instance a min corner and (top, side, bottom layer, packed light). */
export class FallingCubes {
  readonly mesh: THREE.Mesh
  private readonly geometry = new THREE.InstancedBufferGeometry()
  private readonly material: VoxelNodeMaterial
  private readonly faceLayers: Uint16Array
  private pos!: THREE.InstancedBufferAttribute
  private info!: THREE.InstancedBufferAttribute
  private capacity = 0

  constructor(tex: THREE.DataArrayTexture, lights: LightUniforms, faceLayers: Uint16Array) {
    this.faceLayers = faceLayers
    const box = new THREE.BoxGeometry(1, 1, 1)
    box.translate(0.5, 0.5, 0.5)
    this.geometry.index = box.index
    this.geometry.setAttribute('position', box.getAttribute('position'))
    this.geometry.setAttribute('normal', box.getAttribute('normal'))
    this.geometry.setAttribute('uv', box.getAttribute('uv'))
    this.grow(64)
    const fpos = attribute('fallPos', 'vec3')
    const info = attribute('fallInfo', 'vec4')
    const n = normalLocal
    // Decoded in the vertex stage and passed as varyings, like the chunk and decoration materials: decoding the
    // packed light in the fragment stage would floor an interpolated value (48 -> 47.9999) and flip the nibbles.
    const layer = varying(select(n.y.greaterThan(0.5), info.x, select(n.y.lessThan(-0.5), info.z, info.y)))
    const sky = varying(info.w.div(16).floor().div(15))
    const blk = varying(info.w.mod(16).div(15))
    const m = new VoxelNodeMaterial(sky)
    m.positionNode = positionLocal.add(fpos)
    const albedo = texture(tex, attribute('uv', 'vec2')).depth(layer.add(0.5).toInt())
    voxelLit(m, { normal: n, sky, blk, ao: float(1), albedo: albedo.rgb }, lights)
    m.colorNode = vec4(albedo.rgb, 1)
    m.maskNode = belowCut() // the layer cut hides what falls above it (spec §4)
    this.material = m
    this.mesh = new THREE.Mesh(this.geometry, m)
    this.mesh.name = 'elovox-falling'
    this.mesh.castShadow = true
    this.mesh.receiveShadow = true
    this.mesh.frustumCulled = false // instances are spread over the world; the box geometry's bounds say nothing
    this.mesh.raycast = () => {}
    this.mesh.visible = false
  }

  /** Draws exactly these cubes this frame. `light(x, y, z)` is the packed voxel light (sky | block << 4). */
  set(cubes: readonly FallingCube[], light: (x: number, y: number, z: number) => number): void {
    if (cubes.length > this.capacity) this.grow(cubes.length)
    cubes.forEach((c, i) => {
      const id = c.voxel & 0xfff
      const l = cubeLight(light, c.x, c.y, c.z)
      this.pos.setXYZ(i, c.x, c.y, c.z)
      this.info.setXYZW(i, this.faceLayers[id * 6 + 2]!, this.faceLayers[id * 6]!, this.faceLayers[id * 6 + 3]!, (l & 15) * 16 + (l >> 4))
    })
    this.pos.needsUpdate = true
    this.info.needsUpdate = true
    this.geometry.instanceCount = cubes.length
    this.mesh.visible = cubes.length > 0
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }

  private grow(n: number): void {
    let cap = Math.max(64, this.capacity)
    while (cap < n) cap *= 2
    this.capacity = cap
    this.pos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3)
    this.info = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4)
    this.pos.setUsage(THREE.DynamicDrawUsage)
    this.info.setUsage(THREE.DynamicDrawUsage)
    this.geometry.setAttribute('fallPos', this.pos)
    this.geometry.setAttribute('fallInfo', this.info)
  }
}
