import * as THREE from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { CHUNK_SPHERE_RADIUS, buildDrawList, frustumPlanes, sphereInFrustum } from '../src/render/chunkCull.ts'

function frustumOf(camera: THREE.PerspectiveCamera): THREE.Frustum {
  camera.updateMatrixWorld()
  return new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem)
}
const cam = () => {
  const c = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 3000)
  c.position.set(100, 60, 100); c.lookAt(300, 20, 300)
  return c
}

describe('chunkCull', () => {
  it('agrees with three\'s Frustum.intersectsSphere on a grid of chunk spheres', () => {
    const f = frustumOf(cam()), planes = frustumPlanes(f)
    let inside = 0
    for (let x = 0; x < 1024; x += 32) for (let z = 0; z < 1024; z += 32) for (let y = 0; y < 128; y += 32) {
      const s = new THREE.Sphere(new THREE.Vector3(x + 16, y + 16, z + 16), CHUNK_SPHERE_RADIUS)
      const want = f.intersectsSphere(s)
      expect(sphereInFrustum(planes, x + 16, y + 16, z + 16, CHUNK_SPHERE_RADIUS)).toBe(want)
      if (want) inside++
    }
    expect(inside).toBeGreaterThan(50) // the grid really straddles the frustum
  })
  it('lists active, visible chunks in the frustum and within range, in instance order, with byte starts', () => {
    const planes = frustumPlanes(frustumOf(cam()))
    const instances = [
      { active: true, visible: true, geometryIndex: 2 }, // in view, near
      { active: false, visible: true, geometryIndex: 0 }, // freed
      { active: true, visible: true, geometryIndex: 1 }, // behind the camera
      { active: true, visible: true, geometryIndex: 0 }, // in view, far
      { active: true, visible: false, geometryIndex: 3 }, // hidden instance
    ]
    const geometries = [{ start: 0, count: 6 }, { start: 6, count: 12 }, { start: 18, count: 3 }, { start: 21, count: 6 }]
    const centres = Float32Array.from([208, 48, 208, 0, 0, 0, 16, 48, 16, 848, 16, 848, 208, 48, 208])
    const starts = new Int32Array(5), counts = new Int32Array(5), indirect = new Uint32Array(5)
    const eye = { x: 100, y: 60, z: 100 }
    expect(buildDrawList(instances, geometries, centres, planes, eye, Infinity, 4, starts, counts, indirect)).toBe(2)
    expect([...starts.subarray(0, 2)]).toEqual([18 * 4, 0])
    expect([...counts.subarray(0, 2)]).toEqual([3, 6])
    expect([...indirect.subarray(0, 2)]).toEqual([0, 3])
    expect(buildDrawList(instances, geometries, centres, planes, eye, 300, 4, starts, counts, indirect)).toBe(1) // the far one is out of range
    expect(indirect[0]).toBe(0)
  })
  it('reads geometry ranges at cull time, so a compaction between passes is seen', () => {
    const planes = frustumPlanes(frustumOf(cam()))
    const instances = [{ active: true, visible: true, geometryIndex: 0 }]
    const geometries = [{ start: 30, count: 6 }]
    const centres = Float32Array.from([208, 48, 208])
    const starts = new Int32Array(1), counts = new Int32Array(1), indirect = new Uint32Array(1)
    buildDrawList(instances, geometries, centres, planes, { x: 100, y: 60, z: 100 }, Infinity, 4, starts, counts, indirect)
    geometries[0]!.start = 6
    buildDrawList(instances, geometries, centres, planes, { x: 100, y: 60, z: 100 }, Infinity, 4, starts, counts, indirect)
    expect(starts[0]).toBe(24)
  })
})
