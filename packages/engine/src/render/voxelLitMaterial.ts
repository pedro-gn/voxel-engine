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
  /**
   * Self-glow, 0..1, added as albedo × emissive whatever the light (flames). Default 0; `glow.value` changes it later.
   * It is per material: a per-instance flicker goes through the instance colour (setColorAt) or an attribute of its own.
   */
  emissive?: number
}

/**
 * A standard node material lit exactly like the voxel world: it shares the chunk lighting model and light terms
 * (voxelLighting.ts) and reads its sky and block light from the voxel cell it stands in, so it darkens in shade and
 * indoors and takes the warm block light near emitters instead of being lit by the scene alone.
 *
 * Only the diffuse term is lit (no specular), but the albedo still goes through the standard material's metalness:
 * keep `metalness` at 0 (the default; a glTF material copied over with metalness 1 would turn black).
 */
export class VoxelLitMaterial extends THREE.MeshStandardNodeMaterial {
  /** Sky light 0..1, the lighting model's gate. */
  readonly sky: N
  /** The non-instanced material's (sky, block) light; null when the light is per instance. */
  readonly voxelLight: THREE.UniformNode<'vec2', THREE.Vector2> | null
  /** The self-glow strength (VoxelLitOptions.emissive). */
  readonly glow: THREE.UniformNode<'float', number>
  /** Kept for clone(); '_' so NodeMaterial.copy skips them. */
  private readonly _lights: LightUniforms
  private readonly _opts: VoxelLitOptions

  constructor(lights: LightUniforms, opts: VoxelLitOptions = {}) {
    super()
    this._lights = lights
    this._opts = { ...opts }
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

  /**
   * A new material over the same light uniforms and options, with this one's plain properties (colour, map, vertex
   * colours, …) and current light and glow, but its own nodes and its own light uniform (Material.clone would call the
   * constructor without the light uniforms).
   */
  clone(): this {
    const m = new VoxelLitMaterial(this._lights, this._opts)
    // NodeMaterial.copy also copies node references: keep the clone's own light graph and uniforms.
    const own = {
      sky: m.sky, voxelLight: m.voxelLight, glow: m.glow, normalNode: m.normalNode, aoNode: m.aoNode, emissiveNode: m.emissiveNode,
      receivedShadowNode: m.receivedShadowNode, receivedShadowPositionNode: m.receivedShadowPositionNode,
    }
    m.copy(this)
    Object.assign(m, own)
    m.glow.value = this.glow.value
    if (m.voxelLight && this.voxelLight) m.voxelLight.value.copy(this.voxelLight.value)
    return m as this
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

/** The InstancedMesh whose light a geometry's `voxelLight` attribute holds (released when either is disposed). */
const owners = new WeakMap<THREE.BufferGeometry, THREE.InstancedMesh>()

/** Makes `mesh` the owner of its geometry, cloning the geometry when another live mesh owns it (GLTFLoader shares them). */
function ownGeometry(mesh: THREE.InstancedMesh): void {
  const owner = owners.get(mesh.geometry)
  if (owner === mesh) return
  if (owner) {
    const g = mesh.geometry.clone()
    g.deleteAttribute(VOXEL_LIGHT_ATTRIBUTE) // the other mesh's light: this one starts at full sky
    mesh.geometry = g
  }
  const g = mesh.geometry
  owners.set(g, mesh)
  const release = () => { if (owners.get(g) === mesh) owners.delete(g) }
  g.addEventListener('dispose', release)
  mesh.addEventListener('dispose', release)
}

/** Creates (or grows) the attribute at the mesh's capacity, full sky [1, 0] where unwritten, and rebuilds the materials. */
function lightAttribute(mesh: THREE.InstancedMesh, reset: boolean): THREE.InstancedBufferAttribute {
  ownGeometry(mesh)
  const cap = mesh.instanceMatrix.count
  const a = mesh.geometry.getAttribute(VOXEL_LIGHT_ATTRIBUTE) as THREE.InstancedBufferAttribute | undefined
  if (a && a.count >= cap && !reset) return a
  const data = new Float32Array(cap * 2)
  for (let i = 0; i < cap; i++) data[i * 2] = 1
  if (a && !reset) data.set((a.array as Float32Array).subarray(0, a.count * 2))
  const next = new THREE.InstancedBufferAttribute(data, 2)
  next.setUsage(THREE.DynamicDrawUsage)
  mesh.geometry.setAttribute(VOXEL_LIGHT_ATTRIBUTE, next)
  // A program built while the attribute was missing reads a constant 0 (sky 0): rebuild it to read the attribute.
  for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m.needsUpdate = true
  return next
}

/**
 * Gives a new InstancedMesh its `voxelLight` attribute, every instance at full sky [1, 0]. Call it when the mesh is
 * made, before its first render: a mesh drawn without the attribute reads sky 0 (black) until its materials rebuild.
 */
export function initVoxelLight(mesh: THREE.InstancedMesh): void {
  lightAttribute(mesh, true)
}

/**
 * Writes instance `index`'s light into the mesh's `voxelLight` attribute and flags the upload. A missing attribute is
 * created (initVoxelLight) and a small one grown to the mesh's capacity, both rebuilding the mesh's materials. The
 * attribute lives on the geometry: a mesh writing into a geometry another live mesh owns gets its own clone of it.
 */
export function setVoxelLight(mesh: THREE.InstancedMesh, index: number, packed: number): void {
  const a = lightAttribute(mesh, false)
  a.setXY(index, skyLight(packed) / 15, blockLight(packed) / 15)
  a.needsUpdate = true
}

/** Sets a non-instanced voxel-lit material's light (a whole model: one material per building). */
export function setMaterialVoxelLight(material: VoxelLitMaterial, packed: number): void {
  if (!material.voxelLight) throw new TypeError('setMaterialVoxelLight needs a material made with { instanced: false }; use setVoxelLight per instance')
  material.voxelLight.value.set(skyLight(packed) / 15, blockLight(packed) / 15)
}
