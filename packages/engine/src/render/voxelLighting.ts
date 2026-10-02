import * as THREE from 'three/webgpu'
import { BRDF_Lambert, Fn, diffuseColor, max, mix, normalView, positionView, positionWorld, smoothstep, transformNormalToView, uniform, vec3 } from 'three/tsl'

/** Loose TSL node type: @types/three models every node as a distinct generic type that these graphs can't satisfy. */
type N = any

const WRAP = 0.25
export const AMBIENT_FLOOR = 0.05
/** World-space offset along the face normal for shadow lookups; replaces three's normalBias (chunk geometry has no normal attribute). */
const SHADOW_NORMAL_OFFSET = 0.06

/** Lambert with a soft wrap, the sun gated by sky light, and hemisphere ambient scaled by aoNode (sky light × voxel AO). */
export class VoxelLightingModel extends THREE.LightingModel {
  readonly sky: N
  constructor(sky: N) {
    super()
    this.sky = sky
  }
  direct({ lightDirection, lightColor, reflectedLight }: { lightDirection: N; lightColor: N; reflectedLight: { directDiffuse: N } }): void {
    const ndl: N = normalView.dot(lightDirection).add(WRAP).div(1 + WRAP).clamp()
    const gate = smoothstep(0.35, 0.95, this.sky)
    reflectedLight.directDiffuse.addAssign(ndl.mul(gate).mul(lightColor).mul(BRDF_Lambert({ diffuseColor: diffuseColor.rgb })))
  }
  indirect(builder: THREE.NodeBuilder): void {
    const { ambientOcclusion, irradiance, reflectedLight } = builder.context as unknown as {
      ambientOcclusion: N; irradiance: N; reflectedLight: { indirectDiffuse: N }
    }
    reflectedLight.indirectDiffuse.addAssign(irradiance.mul(BRDF_Lambert({ diffuseColor })))
    reflectedLight.indirectDiffuse.mulAssign(ambientOcclusion)
  }
}

export class VoxelNodeMaterial extends THREE.MeshLambertNodeMaterial {
  /** Defined on NodeMaterial at runtime; @types/three only declares it on the standard materials. */
  declare emissiveNode: THREE.Node | null
  readonly sky: N
  constructor(sky: N) {
    super()
    this.sky = sky
  }
  /** @types/three types this as PhongLightingModel; the TSL model needs none of its specular members. */
  setupLightingModel(): N {
    return new VoxelLightingModel(this.sky)
  }
}

export interface LightUniforms {
  /** Direct-light multiplier inside full shadow: mix(white, atmosphere.shadow.tint, strength). */
  shadowColor: N
  torchColor: N
  /** Distance from the camera at which shadows have faded out (Deviation 6). */
  shadowFar: N
}

export function createLightUniforms(): LightUniforms {
  return {
    shadowColor: uniform(new THREE.Color(1, 1, 1)),
    torchColor: uniform(new THREE.Color(1, 0.72, 0.42)),
    shadowFar: uniform(210),
  }
}

export interface VoxelSurface { normal: N; sky: N; blk: N; ao: N; albedo: N }

/** Wires the voxel light terms into a material. `normal` is in world space. */
export function voxelLit(m: VoxelNodeMaterial, s: VoxelSurface, lights: LightUniforms): void {
  m.normalNode = transformNormalToView(s.normal)
  m.receivedShadowPositionNode = positionWorld.add(s.normal.mul(SHADOW_NORMAL_OFFSET))
  m.receivedShadowNode = Fn(([shadow]: [N]) => {
    const fade = smoothstep(lights.shadowFar.mul(0.85), lights.shadowFar, positionView.length())
    return mix(lights.shadowColor, vec3(1), max(shadow, fade))
  }) as unknown as () => THREE.Node
  m.aoNode = s.ao.mul(max(s.sky.pow(1.6), AMBIENT_FLOOR))
  m.emissiveNode = s.albedo.mul(lights.torchColor).mul(s.blk.pow(1.8).mul(1.4))
}
