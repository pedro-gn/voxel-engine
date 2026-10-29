import * as THREE from 'three/webgpu'
import { attribute, diffuseColor, float, normalView, normalWorld, uniform, varying } from 'three/tsl'
import { blockLight, skyLight } from '../world/voxel.ts'
import { VoxelLightingModel, voxelLit, type LightUniforms } from './voxelLighting.ts'

/** Loose TSL node type (see voxelLighting.ts). */
type N = any

/** The per-instance (sky, block) light attribute an instanced voxel-lit material reads, each 0..1. */
export const VOXEL_LIGHT_ATTRIBUTE = 'voxelLight'

export interface VoxelLitOptions {
  /**
   * True (default): each instance's light comes from the `voxelLight` instanced attribute (setVoxelLight), for an
   * InstancedMesh. False: one light for the whole material, from a uniform (setMaterialVoxelLight), for a whole model.
   */
  instanced?: boolean
  /** Multiply the albedo by the geometry's `color` attribute (palette vertex colours). */
  vertexColors?: boolean
  /** Self-glow, 0..1, added as albedo × emissive whatever the light (flames). Default 0; `glow.value` changes it later. */
  emissive?: number
}

/**
 * A standard node material lit exactly like the voxel world: it shares the chunk lighting model and light terms
 * (voxelLighting.ts) and reads its sky and block light from the voxel cell it stands in, so it darkens in shade and
 * indoors and takes the warm block light near emitters instead of being lit by the scene alone.
 */
export class VoxelLitMaterial extends THREE.MeshStandardNodeMaterial {
  /** Sky light 0..1, the lighting model's gate. */
  readonly sky: N
  /** The non-instanced material's (sky, block) light; null when the light is per instance. */
  readonly voxelLight: THREE.UniformNode<'vec2', THREE.Vector2> | null
  /** The self-glow strength (VoxelLitOptions.emissive). */
  readonly glow: THREE.UniformNode<'float', number>

  constructor(lights: LightUniforms, opts: VoxelLitOptions = {}) {
    super()
    const instanced = opts.instanced ?? true
    let sky: N, blk: N
    if (instanced) {
      const l = attribute(VOXEL_LIGHT_ATTRIBUTE, 'vec2') as N
      sky = varying(l.x); blk = varying(l.y)
      this.voxelLight = null
    } else {
      const u = uniform(new THREE.Vector2(1, 0))
      sky = (u as N).x; blk = (u as N).y
      this.voxelLight = u as unknown as THREE.UniformNode<'vec2', THREE.Vector2>
    }
    this.sky = sky
    this.glow = uniform(opts.emissive ?? 0) as unknown as THREE.UniformNode<'float', number>
    this.vertexColors = opts.vertexColors ?? false
    // diffuseColor is the material's own albedo: colour × map × vertex colours × instance colour.
    const albedo = (diffuseColor as N).rgb
    voxelLit(this, { normal: normalWorld, normalView, sky, blk, ao: float(1), albedo }, lights)
    this.emissiveNode = (this.emissiveNode as N).add(albedo.mul(this.glow))
  }

  /** The chunk lighting model (@types/three types this as PhysicalLightingModel). */
  setupLightingModel(): N {
    return new VoxelLightingModel(this.sky)
  }

  customProgramCacheKey(): string {
    return `voxelLit:${super.customProgramCacheKey()}`
  }
}

/** A voxel-lit material over the given light uniforms (the engine passes its own: engine.createVoxelLitMaterial). */
export function createVoxelLitMaterial(lights: LightUniforms, opts: VoxelLitOptions = {}): VoxelLitMaterial {
  return new VoxelLitMaterial(lights, opts)
}

/** `[sky / 15, block / 15]` of a packed voxel light (engine.world.getLight). */
export function voxelLightOf(packed: number): [number, number] {
  return [skyLight(packed) / 15, blockLight(packed) / 15]
}

/**
 * Writes instance `index`'s light into the mesh's `voxelLight` attribute and flags the upload. The attribute is created
 * on first use (grown when the mesh's capacity grew), every instance at full sky `[1, 0]`. It lives on the geometry, so
 * two InstancedMeshes drawn at once need their own geometries (`geometry.clone()`).
 */
export function setVoxelLight(mesh: THREE.InstancedMesh, index: number, packed: number): void {
  const cap = mesh.instanceMatrix.count
  let a = mesh.geometry.getAttribute(VOXEL_LIGHT_ATTRIBUTE) as THREE.InstancedBufferAttribute | undefined
  if (!a || a.count < cap) {
    const data = new Float32Array(cap * 2)
    for (let i = 0; i < cap; i++) data[i * 2] = 1
    if (a) data.set((a.array as Float32Array).subarray(0, a.count * 2))
    a = new THREE.InstancedBufferAttribute(data, 2)
    a.setUsage(THREE.DynamicDrawUsage)
    mesh.geometry.setAttribute(VOXEL_LIGHT_ATTRIBUTE, a)
  }
  a.setXY(index, skyLight(packed) / 15, blockLight(packed) / 15)
  a.needsUpdate = true
}

/** Sets a non-instanced voxel-lit material's light (a whole model: one material per building). */
export function setMaterialVoxelLight(material: VoxelLitMaterial, packed: number): void {
  if (!material.voxelLight) throw new TypeError('setMaterialVoxelLight needs a material made with { instanced: false }; use setVoxelLight per instance')
  material.voxelLight.value.set(skyLight(packed) / 15, blockLight(packed) / 15)
}
