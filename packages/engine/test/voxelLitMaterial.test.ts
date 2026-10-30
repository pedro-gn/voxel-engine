import { describe, expect, it } from 'vitest'
import * as THREE from 'three/webgpu'
import { createLightUniforms } from '../src/render/voxelLighting.ts'
import { createVoxelLitMaterial, initVoxelLight, setMaterialVoxelLight, setVoxelLight, voxelLightOf } from '../src/render/voxelLitMaterial.ts'
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

  it('initVoxelLight fills a fresh mesh with full sky and rebuilds its material', () => {
    const mat = createVoxelLitMaterial(createLightUniforms())
    const m = new THREE.InstancedMesh(new THREE.BoxGeometry(), mat, 3)
    const v = mat.version
    initVoxelLight(m)
    const a = m.geometry.getAttribute('voxelLight') as THREE.InstancedBufferAttribute
    for (let i = 0; i < 3; i++) expect([a.getX(i), a.getY(i)]).toEqual([1, 0])
    expect(mat.version).toBeGreaterThan(v) // needsUpdate: a program built without the attribute reads sky 0
  })

  it('clone keeps its own light uniform', () => {
    const m = createVoxelLitMaterial(createLightUniforms(), { instanced: false, vertexColors: true })
    m.color.set(0x336699)
    setMaterialVoxelLight(m, packLight(10, 2))
    const c = m.clone()
    expect(c).toBeInstanceOf(THREE.MeshStandardNodeMaterial)
    expect(c.vertexColors).toBe(true)
    expect(c.color.getHex()).toBe(0x336699)
    expect(c.voxelLight).not.toBe(m.voxelLight)
    expect(c.voxelLight!.value.toArray()).toEqual(m.voxelLight!.value.toArray())
    setMaterialVoxelLight(c, packLight(0, 15))
    expect(m.voxelLight!.value.x).toBeCloseTo(10 / 15)
    expect(m.voxelLight!.value.y).toBeCloseTo(2 / 15)
  })

  it('two live meshes sharing a geometry keep their own light', () => {
    const g = new THREE.BoxGeometry(), mat = createVoxelLitMaterial(createLightUniforms())
    const a = new THREE.InstancedMesh(g, mat, 2), b = new THREE.InstancedMesh(g, mat, 2)
    setVoxelLight(a, 0, packLight(15, 0))
    setVoxelLight(b, 0, packLight(0, 15))
    const la = a.geometry.getAttribute('voxelLight') as THREE.InstancedBufferAttribute
    const lb = b.geometry.getAttribute('voxelLight') as THREE.InstancedBufferAttribute
    expect([la.getX(0), la.getY(0)]).toEqual([1, 0])
    expect([lb.getX(0), lb.getY(0)]).toEqual([0, 1])
    expect(b.geometry).not.toBe(a.geometry)
    // A disposed owner releases the geometry: a new mesh takes it over without a clone.
    a.dispose()
    const c = new THREE.InstancedMesh(a.geometry, mat, 2)
    setVoxelLight(c, 1, packLight(5, 5))
    expect(c.geometry).toBe(a.geometry)
  })
})
