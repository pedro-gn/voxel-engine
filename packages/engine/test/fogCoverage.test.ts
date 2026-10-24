import * as THREE from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { DecorationRegistry } from '../src/render/decorations/defs.ts'
import { createDecorationMaterials } from '../src/render/decorations/material.ts'
import { FallingCubes } from '../src/render/falling.ts'
import { FragmentMeshes } from '../src/render/fragments.ts'
import { createBodyMaterials, createChunkMaterials } from '../src/render/materials.ts'
import { createLightUniforms } from '../src/render/voxelLighting.ts'
import { WaterMaterial } from '../src/render/water.ts'
import { Layout } from '../src/world/layout.ts'
import { testRegistry } from './helpers.ts'

/**
 * Spec 4b §5.3, expert note 1: the view-distance edge lives in scene.fogNode, so every world material must take the scene
 * fog, or the 0.75R–R band would show unfogged objects. Node materials apply scene.fogNode in setupOutput when fog is on.
 * Units and the bean (glTF materials) are covered by e2e/view-distance.spec.ts.
 */
describe('every world material takes the scene fog node', () => {
  it('chunks (4 layers), voxel bodies (3), decorations, water (5 materials), falling cubes and fragments', () => {
    const tex = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1)
    const lights = createLightUniforms()
    const registry = testRegistry()
    const faceLayers = new Uint16Array(registry.count * 6)
    const water = new WaterMaterial(lights, true)
    const deco = createDecorationMaterials(new DecorationRegistry([], registry), lights)
    const fragments = new FragmentMeshes(new Layout([64, 64, 64]), registry, faceLayers, tex, lights)
    const materials: [string, THREE.Material][] = [
      ...Object.entries(createChunkMaterials(tex, lights)).map(([k, m]) => [`chunk ${k}`, m] as [string, THREE.Material]),
      ...Object.entries(createBodyMaterials(tex, lights, undefined, { fringe: true })).map(([k, m]) => [`body ${k}`, m] as [string, THREE.Material]),
      ['grass', deco.grass], ['flowers', deco.flowers],
      ['water voxel', water.voxel], ['water surface', water.surface], ['water curtain', water.curtain],
      ['water plain surface', water.plainSurface], ['water plain curtain', water.plainCurtain],
      ['falling', new FallingCubes(tex, lights, faceLayers).mesh.material as THREE.Material],
      ...[...(fragments as unknown as { materials: Map<number, THREE.Material> }).materials].map(([k, m]) => [`fragment ${k}`, m] as [string, THREE.Material]),
    ]
    expect(materials.length).toBe(4 + 3 + 2 + 5 + 1 + 3)
    for (const [name, m] of materials) {
      expect((m as unknown as { isNodeMaterial?: boolean }).isNodeMaterial, name).toBe(true)
      expect((m as THREE.Material & { fog?: boolean }).fog, name).toBe(true)
    }
  })
})
