import * as THREE from 'three/webgpu'
import { ChunkMeshes, createChunkMaterials, createLightUniforms, SunLights, PRESETS, resolveAtmosphere, BlockRegistry, defineBlock, meshTablesFrom, meshChunk, createSnapshot, padIndex, Layout } from '@elovox/engine/testing/render'

/** A uniformly lit, uniformly coloured patch of the production voxel ground. */
export async function renderBands(forceWebGL = false, elevation = 30, shadows = true, mapSize = 2048) {
  const canvas = document.createElement('canvas')
  document.body.replaceChildren(canvas)
  const renderer = new THREE.WebGPURenderer({ canvas, forceWebGL, antialias: false })
  await renderer.init()
  renderer.setSize(512, 512)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 3000)
  const distance = 15, pitch = 0.85
  const lights = createLightUniforms()
  lights.shadowColor.value.setRGB(0.6, 0.6, 0.6)
  const tex = new THREE.DataArrayTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, 1)
  tex.needsUpdate = true
  const materials = createChunkMaterials(tex, lights)
  const layout = new Layout([32, 96, 32])
  const chunks = new ChunkMeshes(layout, materials, { batched: true })
  const registry = new BlockRegistry([defineBlock({ name: 'stone', textures: 'stone' })])
  const tables = meshTablesFrom(registry, registry.faceLayers(new Map([['stone', 0]])))
  const snap = createSnapshot()
  snap.light.fill(15)
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y <= 28; y++) snap.voxels[padIndex(x + 1, y + 1, z + 1)] = 1
  chunks.apply(layout.chunkIndex(0, 1, 0), meshChunk(snap, tables))
  scene.add(chunks.group)
  const sun = new SunLights(scene, mapSize)
  sun.apply(resolveAtmosphere(PRESETS.open, {
    sun: { azimuth: 110, elevation, color: '#ffffff', intensity: 0.8 },
    ambient: { sky: '#ffffff', ground: '#ffffff', intensity: 0.2 },
  }))
  sun.setEnabled(shadows)
  const target = new THREE.RenderTarget(512, 512, { type: THREE.UnsignedByteType })
  let min = 255, max = 0
  // Orbiting refits the shadow map; the same flat ground must stay uniformly lit at every angle.
  for (const yaw of [0.7, 0.85, 1.1]) {
    camera.position.set(16 + distance * Math.cos(pitch) * Math.sin(yaw), 61 + distance * Math.sin(pitch), 16 + distance * Math.cos(pitch) * Math.cos(yaw))
    camera.lookAt(16, 61, 16)
    camera.updateMatrixWorld()
    chunks.beginFrame(camera.position, Infinity)
    sun.fit(camera, 96, 0, 96, mapSize)
    renderer.setRenderTarget(target)
    renderer.render(scene, camera)
    const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 512, 512)
    for (let y = 96; y < 416; y++) for (let x = 96; x < 416; x++) {
      const v = pixels[(y * 512 + x) * 4]!
      min = Math.min(min, v); max = Math.max(max, v)
    }
  }
  renderer.setRenderTarget(null)
  renderer.render(scene, camera)
  return { min, max, range: max - min }
}
