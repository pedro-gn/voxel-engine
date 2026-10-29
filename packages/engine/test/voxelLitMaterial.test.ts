import { describe, expect, it } from 'vitest'
import * as THREE from 'three/webgpu'
import { createLightUniforms } from '../src/render/voxelLighting.ts'
import { createVoxelLitMaterial, setMaterialVoxelLight, setVoxelLight, voxelLightOf } from '../src/render/voxelLitMaterial.ts'
import { packLight } from '../src/world/voxel.ts'

describe('voxel-lit meshes', () => {
  it('voxelLightOf splits the nibbles', () => {
    expect(voxelLightOf(packLight(15, 0))).toEqual([1, 0])
    const [sky, blk] = voxelLightOf(packLight(3, 14))
    expect(sky).toBeCloseTo(0.2)
    expect(blk).toBeCloseTo(14 / 15)
  })

  it('setVoxelLight writes one instance', () => {
    const m = new THREE.InstancedMesh(new THREE.BoxGeometry(), createVoxelLitMaterial(createLightUniforms()), 4)
    setVoxelLight(m, 2, packLight(0, 15))
    const a = m.geometry.getAttribute('voxelLight') as THREE.InstancedBufferAttribute
    expect(a.isInstancedBufferAttribute).toBe(true)
    expect([a.getX(2), a.getY(2)]).toEqual([0, 1])
    expect([a.getX(0), a.getY(0)]).toEqual([1, 0])
    expect(a.version).toBeGreaterThan(0) // needsUpdate was set
  })

  it('setMaterialVoxelLight sets the uniform', () => {
    const m = createVoxelLitMaterial(createLightUniforms(), { instanced: false, vertexColors: true })
    expect(m).toBeInstanceOf(THREE.MeshStandardNodeMaterial)
    expect(m.vertexColors).toBe(true)
    expect(m.voxelLight!.value.toArray()).toEqual([1, 0])
    setMaterialVoxelLight(m, packLight(6, 9))
    expect(m.voxelLight!.value.x).toBeCloseTo(6 / 15)
    expect(m.voxelLight!.value.y).toBeCloseTo(9 / 15)
  })
})
