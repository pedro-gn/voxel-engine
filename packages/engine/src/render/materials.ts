import * as THREE from 'three/webgpu'
import { texture, vec4 } from 'three/tsl'
import { chunkVertex } from './chunkVertex.ts'
import { VoxelNodeMaterial, voxelLit, type LightUniforms } from './voxelLighting.ts'

export interface ChunkMaterials {
  opaque: VoxelNodeMaterial
  cutout: VoxelNodeMaterial
  translucent: VoxelNodeMaterial
}

export function createChunkMaterials(tex: THREE.DataArrayTexture, lights: LightUniforms): ChunkMaterials {
  function build(mode: 'opaque' | 'cutout' | 'translucent'): VoxelNodeMaterial {
    const v = chunkVertex()
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
  return { opaque: build('opaque'), cutout: build('cutout'), translucent: build('translucent') }
}
