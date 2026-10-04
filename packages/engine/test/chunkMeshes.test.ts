import * as THREE from 'three/webgpu'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChunkMeshData } from '../src/mesh/mesher.ts'
import type { LayerMesh } from '../src/mesh/quadBuilder.ts'
import { FACE, packA } from '../src/mesh/vertexFormat.ts'
import { ChunkMeshes } from '../src/render/chunkMeshes.ts'
import { NEW_DROP } from '../src/render/liquidBlend.ts'
import type { ChunkMaterials } from '../src/render/materials.ts'
import { Layout } from '../src/world/layout.ts'

let clock = 1000
afterEach(() => vi.restoreAllMocks())

function setup(): ChunkMeshes {
  clock = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  const m = () => new THREE.MeshBasicMaterial()
  const mats = { opaque: m(), cutout: m(), translucent: m(), liquid: m() } as unknown as ChunkMaterials
  return new ChunkMeshes(new Layout([64, 64, 64]), mats)
}

/** One +Y liquid quad at cell (1, 1, 1) whose four corners all have `drop`. */
function topQuad(drop: number): LayerMesh {
  const vertices = new Uint32Array(8)
  for (let c = 0; c < 4; c++) vertices[c * 2] = packA(1 + (c === 1 || c === 2 ? 1 : 0), 2, 1 + (c >= 2 ? 1 : 0), FACE.PY, 0, c, drop)
  return { vertices, indices: Uint32Array.of(0, 1, 2, 0, 2, 3) }
}

function data(liquid: LayerMesh | null, opaque: LayerMesh | null = null): ChunkMeshData {
  return { opaque, cutout: null, translucent: null, liquid, grass: null, flowers: null }
}

function liquidGeo(cm: ChunkMeshes): THREE.BufferGeometry {
  const mesh = cm.group.children.find((o) => o.name.endsWith('-liquid')) as THREE.Mesh
  return mesh.geometry
}

const attr = (g: THREE.BufferGeometry, name: string) => [...(g.getAttribute(name).array as Float32Array)]

describe('ChunkMeshes liquid blend', () => {
  it('runs its clock in seconds from construction', () => {
    const cm = setup()
    clock = 1500
    expect(cm.now()).toBeCloseTo(0.5)
  })

  it('adds prevDrop and t0 to liquid geometry only; new water rises from the cell bottom', () => {
    const cm = setup()
    clock = 1250
    cm.apply(0, data(topQuad(4), topQuad(0)))
    const g = liquidGeo(cm)
    expect(attr(g, 'prevDrop')).toEqual([NEW_DROP, NEW_DROP, NEW_DROP, NEW_DROP])
    expect(attr(g, 't0')).toEqual([0.25, 0.25, 0.25, 0.25])
    const opaque = cm.group.children.find((o) => o.name.endsWith('-opaque')) as THREE.Mesh
    expect(opaque.geometry.getAttribute('prevDrop')).toBeUndefined()
  })

  it('glides a remesh from the height on screen', () => {
    const cm = setup()
    cm.apply(0, data(topQuad(4)))
    clock = 2000 // long past the blend: drop 4 is on screen
    cm.apply(0, data(topQuad(10)))
    expect(attr(liquidGeo(cm), 'prevDrop')).toEqual([4, 4, 4, 4])
  })

  it('forgets the state when the liquid layer or the chunk goes away', () => {
    const cm = setup()
    cm.apply(0, data(topQuad(4)))
    clock = 2000
    cm.apply(0, data(null, topQuad(0)))
    cm.apply(0, data(topQuad(4)))
    expect(attr(liquidGeo(cm), 'prevDrop')).toEqual([NEW_DROP, NEW_DROP, NEW_DROP, NEW_DROP])
    clock = 3000
    cm.remove(0)
    cm.apply(0, data(topQuad(4)))
    expect(attr(liquidGeo(cm), 'prevDrop')).toEqual([NEW_DROP, NEW_DROP, NEW_DROP, NEW_DROP])
  })
})
