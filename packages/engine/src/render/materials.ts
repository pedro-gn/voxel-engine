import * as THREE from 'three/webgpu'
import { cameraViewMatrix, float, mix, texture, uniformArray, vec4 } from 'three/tsl'
import { CUT_SHADE } from '../mesh/vertexFormat.ts'
import { FRINGE_LOD_BIAS, chunkVertex, fringeSampleUv, type ToneTables } from './chunkVertex.ts'
import { belowCut } from './layerCut.ts'
import { VoxelNodeMaterial, voxelLit, type LightUniforms } from './voxelLighting.ts'

export interface ChunkMaterials {
  opaque: VoxelNodeMaterial
  cutout: VoxelNodeMaterial
  translucent: VoxelNodeMaterial
  liquid: VoxelNodeMaterial
}

export interface ChunkMaterialOptions {
  /** Per texture-layer leaf tones (BlockRegistry.toneLayers); given only when the registry has tone blocks. */
  tone?: { dark: Float32Array; light: Float32Array; jitter: Float32Array }
  /** The registry has fringe blocks (BlockRegistry.hasFringe): the cutout material decodes strips, which cast no shadow. */
  fringe?: boolean
}

/** The per-layer tone tables as two vec4 uniform arrays: (dark rgb, jitter) and (light rgb, 0). */
function toneTables(t: NonNullable<ChunkMaterialOptions['tone']>): ToneTables {
  const dark: THREE.Vector4[] = [], light: THREE.Vector4[] = []
  for (let l = 0; l < t.jitter.length; l++) {
    dark.push(new THREE.Vector4(t.dark[l * 3]!, t.dark[l * 3 + 1]!, t.dark[l * 3 + 2]!, t.jitter[l]!))
    light.push(new THREE.Vector4(t.light[l * 3]!, t.light[l * 3 + 1]!, t.light[l * 3 + 2]!, 0))
  }
  return { dark: uniformArray(dark, 'vec4'), light: uniformArray(light, 'vec4') } as unknown as ToneTables
}

/**
 * `layerScales`: blocks spanned by one repeat of each texture-array layer (see `layerScales` in tiles.ts); omit for 1
 * everywhere. `opts.tone` changes the cutout material only: it decodes the cutout stream's tone bits and tints the face.
 */
export function createChunkMaterials(tex: THREE.DataArrayTexture, lights: LightUniforms, layerScales?: Float32Array, opts: ChunkMaterialOptions = {}): ChunkMaterials {
  const build = materialBuilder(tex, lights, layerScales, opts, false)
  return { opaque: build('opaque'), cutout: build('cutout'), translucent: build('translucent'), liquid: build('translucent', true) }
}

export interface BodyMaterials {
  opaque: VoxelNodeMaterial
  cutout: VoxelNodeMaterial
  translucent: VoxelNodeMaterial
}

/**
 * The chunk materials' body variant (voxelBody.ts), with the same arguments as createChunkMaterials: object-space UVs
 * shifted by `object.userData.uvOrigin` (Vector3), the axis normal rotated with the object, the baked light eased
 * towards open sky by `object.userData.ease` (0..1), and the layer cut in the colour and shadow passes (a moving body
 * crosses it anywhere). Shared by every body; `userData.body` marks them.
 */
export function createBodyMaterials(tex: THREE.DataArrayTexture, lights: LightUniforms, layerScales?: Float32Array, opts: ChunkMaterialOptions = {}): BodyMaterials {
  const build = materialBuilder(tex, lights, layerScales, opts, true)
  return { opaque: build('opaque'), cutout: build('cutout'), translucent: build('translucent') }
}

function materialBuilder(tex: THREE.DataArrayTexture, lights: LightUniforms, layerScales: Float32Array | undefined, opts: ChunkMaterialOptions, body: boolean) {
  const scales = layerScales && layerScales.some((s) => s !== 1) ? uniformArray(Array.from(layerScales), 'float') : undefined
  const tone = opts.tone ? toneTables(opts.tone) : undefined
  return function build(mode: 'opaque' | 'cutout' | 'translucent', liquid = false): VoxelNodeMaterial {
    const toned = mode === 'cutout' && tone !== undefined
    const fringed = mode === 'cutout' && opts.fringe === true
    const v = chunkVertex(scales as Parameters<typeof chunkVertex>[0], liquid, { ...(toned && { tone }), ...(fringed && { fringe: true }), ...(body && { body: true }) })
    const m = new VoxelNodeMaterial(v.sky)
    m.positionNode = v.position
    // Fringe strips sample their mask at mip 0 with v clamped inside its first and last rows (chunkVertex.ts fringeVRange).
    const sample = fringed && v.fringe
      ? texture(tex, fringeSampleUv(v.uv, v.fringe, tex.image.height)).bias(v.fringe.mul(FRINGE_LOD_BIAS))
      : texture(tex, v.uv)
    const albedo = sample.depth(v.layer.add(0.5).toInt())
    // Faces created by the layer cut read a little darker than the ground (spec §4). Branch-free (no select()).
    const shaded = albedo.rgb.mul(mix(float(1), float(CUT_SHADE), v.cut))
    const rgb = v.tint ? shaded.mul(v.tint) : shaded
    if (toned) m.userData.tone = true
    if (fringed && v.fringe) {
      m.userData.fringe = true
      // Strips add no shadow shell (spec §9): the shadow pass discards their fragments.
      m.maskShadowNode = v.fringe.lessThan(0.5)
    }
    if (body) {
      m.userData.body = true
      // A body's cells above the layer cut are hidden in colour and in the shadow map (falling.ts does the same).
      m.maskNode = belowCut()
      m.maskShadowNode = m.maskShadowNode ? (m.maskShadowNode as ReturnType<typeof belowCut>).and(belowCut()) : belowCut()
    }
    // A body's normal is already rotated into world space: give the view-space one directly (no second model rotation).
    const normalView = body ? cameraViewMatrix.mul(vec4(v.normal, 0)).xyz.normalize() : undefined
    voxelLit(m, { normal: v.normal, sky: v.sky, blk: v.blk, ao: v.ao, albedo: rgb, ...(normalView && { normalView }) }, lights)
    if (mode === 'opaque') {
      m.colorNode = vec4(rgb, 1)
      // Internal voxel faces are culled. Back-face shadow casting (three's default)
      // leaves light leaks where walls meet the floor; cast the exposed front faces.
      m.shadowSide = THREE.FrontSide
    } else if (mode === 'cutout') {
      m.colorNode = vec4(rgb, albedo.a)
      m.alphaTest = 0.5
      m.side = THREE.DoubleSide
    } else {
      m.colorNode = vec4(albedo.rgb, albedo.a.mul(0.85))
      m.transparent = true
      m.depthWrite = false
    }
    return m
  }
}
