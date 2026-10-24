import * as THREE from 'three/webgpu'
import { float, mix, texture, uniformArray, vec4 } from 'three/tsl'
import { CUT_SHADE } from '../mesh/vertexFormat.ts'
import { chunkVertex, type ToneTables } from './chunkVertex.ts'
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
  const scales = layerScales && layerScales.some((s) => s !== 1) ? uniformArray(Array.from(layerScales), 'float') : undefined
  const tone = opts.tone ? toneTables(opts.tone) : undefined
  function build(mode: 'opaque' | 'cutout' | 'translucent', liquid = false): VoxelNodeMaterial {
    const toned = mode === 'cutout' && tone !== undefined
    const fringed = mode === 'cutout' && opts.fringe === true
    const v = chunkVertex(scales as Parameters<typeof chunkVertex>[0], liquid, { ...(toned && { tone }), ...(fringed && { fringe: true }) })
    const m = new VoxelNodeMaterial(v.sky)
    m.positionNode = v.position
    const albedo = texture(tex, v.uv).depth(v.layer.add(0.5).toInt())
    // Faces created by the layer cut read a little darker than the ground (spec §4). Branch-free (no select()).
    const shaded = albedo.rgb.mul(mix(float(1), float(CUT_SHADE), v.cut))
    const rgb = v.tint ? shaded.mul(v.tint) : shaded
    if (toned) m.userData.tone = true
    if (fringed && v.fringe) {
      m.userData.fringe = true
      // Strips add no shadow shell (spec §9): the shadow pass discards their fragments.
      m.maskShadowNode = v.fringe.lessThan(0.5)
    }
    voxelLit(m, { normal: v.normal, sky: v.sky, blk: v.blk, ao: v.ao, albedo: rgb }, lights)
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
  return { opaque: build('opaque'), cutout: build('cutout'), translucent: build('translucent'), liquid: build('translucent', true) }
}
