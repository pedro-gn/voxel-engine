import * as THREE from 'three/webgpu'
import { float, mix, texture, uniformArray, vec4 } from 'three/tsl'
import { CUT_SHADE } from '../mesh/vertexFormat.ts'
import { chunkVertex } from './chunkVertex.ts'
import { VoxelNodeMaterial, voxelLit, type LightUniforms } from './voxelLighting.ts'

export interface ChunkMaterials {
  opaque: VoxelNodeMaterial
  cutout: VoxelNodeMaterial
  translucent: VoxelNodeMaterial
  liquid: VoxelNodeMaterial
}

/** `layerScales`: blocks spanned by one repeat of each texture-array layer (see `layerScales` in tiles.ts); omit for 1 everywhere. */
export function createChunkMaterials(tex: THREE.DataArrayTexture, lights: LightUniforms, layerScales?: Float32Array): ChunkMaterials {
  const scales = layerScales && layerScales.some((s) => s !== 1) ? uniformArray(Array.from(layerScales), 'float') : undefined
  function build(mode: 'opaque' | 'cutout' | 'translucent', liquid = false): VoxelNodeMaterial {
    const v = chunkVertex(scales as Parameters<typeof chunkVertex>[0], liquid)
    const m = new VoxelNodeMaterial(v.sky)
    m.positionNode = v.position
    const albedo = texture(tex, v.uv).depth(v.layer.add(0.5).toInt())
    // Faces created by the layer cut read a little darker than the ground (spec §4). Branch-free (no select()).
    const rgb = albedo.rgb.mul(mix(float(1), float(CUT_SHADE), v.cut))
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
