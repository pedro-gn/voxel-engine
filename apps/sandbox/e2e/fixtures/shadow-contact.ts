import * as THREE from 'three/webgpu'
import { ChunkMeshes, createChunkMaterials, createLightUniforms, SunLights, PRESETS, resolveAtmosphere, BlockRegistry, defineBlock, meshTablesFrom, meshChunk, createSnapshot, padIndex, Layout } from '@elovox/engine/testing/render'

/** A white voxel wall joined to a floor: production mesher, packed vertices, materials and sun. */
export async function renderContact(forceWebGL: boolean, terrace: boolean) {
  const canvas = document.querySelector('canvas')!
  const renderer = new THREE.WebGPURenderer({ canvas, forceWebGL, antialias: false })
  await renderer.init()
  const backend = (renderer.backend as unknown as { isWebGLBackend?: boolean }).isWebGLBackend ? 'webgl' : 'webgpu'
  renderer.setSize(512, 512)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-3, 3, 3, -3, 0.1, 100)
  camera.position.set(23, 7, 16)
  camera.lookAt(17, 1, 16)
  camera.updateMatrixWorld()
  const lights = createLightUniforms()
  lights.shadowColor.value.setRGB(0, 0, 0)
  const tex = new THREE.DataArrayTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, 1)
  tex.needsUpdate = true
  const materials = createChunkMaterials(tex, lights)
  const chunks = new ChunkMeshes(new Layout([32, 32, 32]), materials)
  const registry = new BlockRegistry([defineBlock({ name: 'stone', textures: 'stone' })])
  const tables = meshTablesFrom(registry, registry.faceLayers(new Map([['stone', 0]])))
  const snap = createSnapshot()
  snap.light.fill(15)
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
    const wall = terrace ? x < 16 : x === 15
    for (let y = 0; y < (wall ? 5 : 1); y++) snap.voxels[padIndex(x + 1, y + 1, z + 1)] = 1
  }
  chunks.apply(0, meshChunk(snap, tables))
  scene.add(chunks.group)
  const sun = new SunLights(scene, 2048)
  sun.apply(resolveAtmosphere(PRESETS.open, {
    sun: { azimuth: 180, elevation: 45, color: '#ffffff', intensity: 1 },
    ambient: { sky: '#ffffff', ground: '#ffffff', intensity: 0.1 },
  }))
  sun.sun.position.set(-20, 37, 16)
  sun.sun.target.position.set(16, 1, 16)
  sun.sun.shadow.camera.left = -16
  sun.sun.shadow.camera.right = 16
  sun.sun.shadow.camera.top = 16
  sun.sun.shadow.camera.bottom = -16
  sun.sun.shadow.camera.near = 0.1
  sun.sun.shadow.camera.far = 100
  sun.sun.shadow.camera.updateProjectionMatrix()
  const target = new THREE.RenderTarget(512, 512, { type: THREE.UnsignedByteType })
  renderer.setRenderTarget(target)
  renderer.render(scene, camera)
  const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 512, 512)
  const sample = (pixels: ArrayLike<number>, xWorld: number, yWorld: number) => {
    let total = 0
    for (const z of [15.5, 15.75, 16, 16.25, 16.5]) {
      const p = new THREE.Vector3(xWorld, yWorld, z).project(camera)
      const x = Math.floor((p.x * 0.5 + 0.5) * 512)
      // Raw WebGPU texture rows start at the top; WebGL readPixels starts at the bottom.
      const py = p.y * 0.5 + 0.5
      const y = Math.floor((backend === 'webgl' ? py : 1 - py) * 512)
      const i = (x + y * 512) * 4
      total += (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / (3 * 255)
    }
    return total / 5
  }
  const samples = [0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1, 2].map((dx) => ({ dx, light: sample(pixels, 16 + dx, 1) }))

  // Verify that front-face casting has not introduced self-shadowing on the sunlit top.
  camera.position.set(21.5, 11, 16)
  camera.lookAt(15.5, 5, 16)
  camera.updateMatrixWorld()
  renderer.render(scene, camera)
  const topPixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 512, 512)
  const sunlit = [15.25, 15.5, 15.75].map((x) => sample(topPixels, x, 5))

  camera.position.set(23, 7, 16)
  camera.lookAt(17, 1, 16)
  camera.updateMatrixWorld()
  renderer.setRenderTarget(null)
  renderer.render(scene, camera)
  return { backend, samples, sunlit }
}
