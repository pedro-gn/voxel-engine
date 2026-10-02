import * as THREE from 'three/webgpu'
import { BlockRegistry, defineBlock } from '@elovox/engine/src/blocks/registry.ts'
import { Mesher } from '@elovox/engine/src/mesh/mesher.ts'
import { meshTablesFrom } from '@elovox/engine/src/mesh/tables.ts'
import { ChunkMeshes } from '@elovox/engine/src/render/chunkMeshes.ts'
import { createChunkMaterials } from '@elovox/engine/src/render/materials.ts'
import { checkerTile } from '@elovox/engine/src/render/tiles.ts'
import { Layout } from '@elovox/engine/src/world/layout.ts'
import { createSnapshot, padIndex } from '@elovox/engine/src/world/reader.ts'
import { packVoxel } from '@elovox/engine/src/world/voxel.ts'

const forceWebGL = new URLSearchParams(location.search).has('webgl')
const canvas = document.querySelector<HTMLCanvasElement>('#view')!
const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL })
await renderer.init()
renderer.setSize(innerWidth, innerHeight, false)
const scene = new THREE.Scene()
scene.background = new THREE.Color(0xdfe3e6)
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 500)
camera.position.set(40, 40, 40)
camera.lookAt(16, 8, 16)

const reg = new BlockRegistry([defineBlock({ name: 'stone' }), defineBlock({ name: 'water', liquid: true })])
const tex = new THREE.DataArrayTexture(new Uint8Array([...checkerTile(64), ...checkerTile(64), ...checkerTile(64)]), 64, 64, 3)
tex.wrapS = tex.wrapT = THREE.RepeatWrapping
tex.needsUpdate = true
const snap = createSnapshot()
snap.light.fill(15)
for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) for (let y = 0; y < 4 + ((x * z) % 5); y++) snap.voxels[padIndex(x + 1, y + 1, z + 1)] = 1
snap.voxels[padIndex(10, 10, 10)] = packVoxel(2, 4)
const data = new Mesher().mesh(snap, meshTablesFrom(reg, new Uint16Array(reg.count * 6).fill(1)))
const meshes = new ChunkMeshes(new Layout([32, 32, 32]), createChunkMaterials(tex))
meshes.apply(0, data)
scene.add(meshes.group)
renderer.setAnimationLoop(() => renderer.render(scene, camera))
document.title = `spike: ${(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl'}`
