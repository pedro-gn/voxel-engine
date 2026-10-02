import * as THREE from 'three/webgpu'
import { texture, uniformArray, vec4 } from 'three/tsl'
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
  function build(mode: 'opaque' | 'cutout' | 'translucent'): VoxelNodeMaterial {
    const v = chunkVertex(scales as Parameters<typeof chunkVertex>[0])
    const m = new VoxelNodeMaterial(v.sky)
    m.positionNode = v.position
    const albedo = texture(tex, v.uv).depth(v.layer.add(0.5).toInt())
    voxelLit(m, { normal: v.normal, sky: v.sky, blk: v.blk, ao: v.ao, albedo: albedo.rgb }, lights)
    if (mode === 'opaque') {
      m.colorNode = vec4(albedo.rgb, 1)
    } else if (mode === 'cutout') {
      m.colorNode = albedo
      m.alphaTest = 0.5
      m.side = THREE.DoubleSide
    } else {
      m.colorNode = vec4(albedo.rgb, albedo.a.mul(0.85))
      m.transparent = true
      m.depthWrite = false
    }
    return m
  }
  return { opaque: build('opaque'), cutout: build('cutout'), translucent: build('translucent'), liquid: build('translucent') }
}
