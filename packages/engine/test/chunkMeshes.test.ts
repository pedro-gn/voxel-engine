import * as THREE from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import type { ChunkMeshData } from '../src/mesh/mesher.ts'
import type { LayerMesh } from '../src/mesh/quadBuilder.ts'
import { FACE, packA } from '../src/mesh/vertexFormat.ts'
import { ChunkMeshes } from '../src/render/chunkMeshes.ts'
import { LayerCut } from '../src/render/layerCut.ts'
import type { ChunkMaterials } from '../src/render/materials.ts'
import { Layout } from '../src/world/layout.ts'

function setup(batched = false): ChunkMeshes {
  const m = () => new THREE.MeshBasicMaterial()
  const mats = { opaque: m(), cutout: m(), translucent: m(), liquid: m() } as unknown as ChunkMaterials
  return new ChunkMeshes(new Layout([64, 64, 64]), mats, { batched })
}

/** One +Y quad at cell (1, 1, 1). */
function quad(): LayerMesh {
  const vertices = new Uint32Array(8)
  for (let c = 0; c < 4; c++) vertices[c * 2] = packA(1 + (c === 1 || c === 2 ? 1 : 0), 2, 1 + (c >= 2 ? 1 : 0), FACE.PY, 0, c, 0)
  return { vertices, indices: Uint32Array.of(0, 1, 2, 0, 2, 3) }
}

function data(liquid: LayerMesh | null, opaque: LayerMesh | null = null): ChunkMeshData {
  return { opaque, cutout: null, translucent: null, liquid, grass: null, flowers: null }
}

describe('ChunkMeshes', () => {
  it('adds a mesh per layer at the chunk\'s centre; liquid meshes draw after glass and carry no blend attributes', () => {
    const cm = setup()
    cm.apply(1, data(quad(), quad()))
    expect(cm.meshCount).toBe(2)
    const liquid = cm.group.getObjectByName('chunk-1-liquid') as THREE.Mesh
    expect(liquid.position.toArray()).toEqual([32 + 16, 16, 16])
    expect(liquid.renderOrder).toBe(1)
    expect(liquid.geometry.getAttribute('prevDrop')).toBeUndefined()
  })
  it('removes a layer that comes back empty, and every layer of a removed chunk', () => {
    const cm = setup()
    cm.apply(0, data(quad(), quad()))
    cm.apply(0, data(null, quad()))
    expect(cm.group.getObjectByName('chunk-0-liquid')).toBeUndefined()
    expect(cm.meshCount).toBe(1)
    cm.remove(0)
    expect(cm.meshCount).toBe(0)
  })
  it('batched: opaque and cutout go into region batches, translucent and liquid stay meshes; counts mean the same', () => {
    const cm = setup(true)
    cm.apply(1, { ...data(quad(), quad()), cutout: quad() })
    expect(cm.meshCount).toBe(3) // opaque + cutout instances + the liquid mesh
    expect(cm.group.getObjectByName('chunk-1-opaque')).toBeUndefined()
    expect(cm.group.getObjectByName('chunk-1-liquid')).toBeInstanceOf(THREE.Mesh)
    expect(cm.shadowCasterCount).toBe(2) // one opaque batch + one cutout batch
    cm.apply(1, data(null, null))
    expect(cm.meshCount).toBe(0)
    cm.apply(2, data(null, quad()))
    cm.remove(2)
    expect(cm.meshCount).toBe(0)
  })
  it('hides per-chunk meshes above the layer cut and shows them again when it is cleared, also at Infinity', () => {
    const cm = setup()
    const layout = new Layout([64, 64, 64]), cut = new LayerCut(layout)
    cm.setCut(cut)
    const low = layout.chunkIndex(0, 0, 0), high = layout.chunkIndex(0, 1, 0)
    cm.apply(low, data(quad(), null)); cm.apply(high, data(quad(), null))
    cut.set(20)
    cm.beginFrame({ x: 16, y: 16, z: 16 }, Infinity)
    expect(cm.group.getObjectByName(`chunk-${low}-liquid`)!.visible).toBe(true)
    expect(cm.group.getObjectByName(`chunk-${high}-liquid`)!.visible).toBe(false)
    cm.apply(layout.chunkIndex(1, 1, 0), data(quad(), null)) // created while hidden
    expect(cm.group.getObjectByName(`chunk-${layout.chunkIndex(1, 1, 0)}-liquid`)!.visible).toBe(false)
    cut.set(null)
    cm.beginFrame({ x: 16, y: 16, z: 16 }, Infinity)
    expect(cm.group.getObjectByName(`chunk-${high}-liquid`)!.visible).toBe(true)
  })
  it('hides per-chunk meshes beyond the view distance, also ones created later, and shows them again at Infinity', () => {
    const m = () => new THREE.MeshBasicMaterial()
    const mats = { opaque: m(), cutout: m(), translucent: m(), liquid: m() } as unknown as ChunkMaterials
    const cm = new ChunkMeshes(new Layout([512, 64, 64]), mats, {})
    cm.apply(0, data(quad(), quad()))
    cm.beginFrame({ x: 16, y: 16, z: 16 }, 100)
    cm.apply(10, data(quad(), null)) // chunk x 320–352: 304 away
    expect(cm.group.getObjectByName('chunk-0-liquid')!.visible).toBe(true)
    expect(cm.group.getObjectByName('chunk-10-liquid')!.visible).toBe(false)
    expect(cm.drawnCount).toBe(2)
    cm.beginFrame({ x: 16, y: 16, z: 16 }, Infinity)
    expect(cm.group.getObjectByName('chunk-10-liquid')!.visible).toBe(true)
    expect(cm.drawnCount).toBe(3)
  })
})
