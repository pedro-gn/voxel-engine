import * as THREE from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { BlockRegistry } from '../src/blocks/registry.ts'
import type { LayerMesh } from '../src/mesh/quadBuilder.ts'
import { Mesher } from '../src/mesh/mesher.ts'
import { meshTablesFrom } from '../src/mesh/tables.ts'
import { FACE, FRINGE_BIT, unpackA, unpackB } from '../src/mesh/vertexFormat.ts'
import { createBodyMaterials, createChunkMaterials } from '../src/render/materials.ts'
import { buildBodyMeshData, createVoxelBody, type VoxelBodyCell } from '../src/render/voxelBody.ts'
import { createLightUniforms } from '../src/render/voxelLighting.ts'
import { FULL_SKY, packLight, packVoxel } from '../src/world/voxel.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'
import { emptySnap, put } from './meshHelpers.ts'

const tex = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1)

describe('body materials', () => {
  it('mask the layer cut in the colour and shadow passes (cutout strips stay out of the shadow); chunk materials are unchanged', () => {
    const lights = createLightUniforms()
    const body = createBodyMaterials(tex, lights, undefined, { fringe: true })
    for (const m of [body.opaque, body.cutout, body.translucent]) {
      expect(m.userData.body).toBe(true)
      expect(m.maskNode).not.toBeNull()
      expect(m.maskShadowNode).not.toBeNull()
    }
    expect(body.cutout.maskShadowNode).not.toBe(body.opaque.maskShadowNode)
    expect([body.cutout.alphaTest, body.cutout.side]).toEqual([0.5, THREE.DoubleSide])
    const chunk = createChunkMaterials(tex, lights, undefined, { fringe: true })
    for (const m of Object.values(chunk)) {
      expect(m.userData.body).toBeUndefined()
      expect(m.maskNode).toBeNull()
    }
    expect(chunk.opaque.maskShadowNode).toBeNull()
  })
})

// Toned, fringed leaves (as in fringe.test.ts); stone stands in for the logs.
const reg = new BlockRegistry(TEST_BLOCKS.map((b) => (b.name === 'leaves' ? { ...b, fringe: { texture: 'fringe' }, tone: { dark: [0.5, 0.6, 0.5], light: [1.2, 1.2, 1] } } : b)))
const layerOf = new Map(reg.textureNames().map((n, i) => [n, i + 1]))
const tables = meshTablesFrom(reg, reg.faceLayers(layerOf), undefined, reg.fringeLayers(layerOf))
const LOG_A = [40, 10, 70] as const
const cells: VoxelBodyCell[] = [
  { x: 40, y: 10, z: 70, voxel: ID.stone },
  { x: 41, y: 10, z: 70, voxel: ID.stone },
  { x: 40, y: 11, z: 70, voxel: packVoxel(ID.leaves, 2) },
  { x: 41, y: 11, z: 70, voxel: ID.water }, // dropped
]

interface V { x: number; y: number; z: number; normal: number; ao: number; corner: number; drop: number; layer: number; sky: number; fringe: boolean }
/** Decoded vertices, positions shifted by `o` (a mesh's world origin). */
function verts(m: LayerMesh | null, o: readonly number[]): V[] {
  const out: V[] = []
  if (!m) return out
  for (let i = 0; i < m.vertices.length; i += 2) {
    const a = unpackA(m.vertices[i]!), b = unpackB(m.vertices[i + 1]!)
    out.push({ ...a, x: a.x + o[0]!, y: a.y + o[1]!, z: a.z + o[2]!, layer: b.layer, sky: b.sky, fringe: (m.vertices[i]! & FRINGE_BIT) !== 0 })
  }
  return out
}
const key = (v: V) => JSON.stringify(v)

describe('buildBodyMeshData', () => {
  it('culls shared faces, keeps the leaf tone and fringe, drops liquids, and lights each face from the cell in front', () => {
    const dark = [LOG_A[0] - 1, LOG_A[1], LOG_A[2]].join()
    const { data, origin } = buildBodyMeshData(cells, tables, (x, y, z) => ([x, y, z].join() === dark ? packLight(5, 0) : FULL_SKY))
    expect(origin).toEqual([40, 10, 70])
    expect([data.liquid, data.translucent, data.grass, data.flowers]).toEqual([null, null, null, null])
    const opaque = verts(data.opaque, [0, 0, 0])
    // No face on the plane between the two logs (local x = 1).
    expect(opaque.filter((v) => (v.normal === FACE.PX || v.normal === FACE.NX) && v.x === 1)).toEqual([])
    expect(new Set(opaque.filter((v) => v.normal === FACE.NX).map((v) => v.sky))).toEqual(new Set([5]))
    expect(new Set(opaque.filter((v) => v.normal === FACE.PX).map((v) => v.sky))).toEqual(new Set([15]))
    const cutout = verts(data.cutout, [0, 0, 0])
    expect(cutout.some((v) => v.fringe)).toBe(true)
    expect(new Set(cutout.map((v) => (v.layer >> 8) & 3))).toEqual(new Set([2]))
  })

  it('a face against a dark solid world cell borrows the brightest light around that cell (review I1)', () => {
    const below = [LOG_A[0], LOG_A[1] - 1, LOG_A[2]] // dirt under the log: light 0, its side neighbours sky 12
    // World light: solid cells (the dirt and the body's own stone "logs") hold 0; the ground row and below sky 12; above, full sky.
    const solid = new Set([below.join(), ...cells.filter((c) => (c.voxel & 0xfff) === ID.stone).map((c) => [c.x, c.y, c.z].join())])
    const light = (x: number, y: number, z: number) => (solid.has([x, y, z].join()) ? 0 : y <= below[1] ? packLight(12, 0) : FULL_SKY)
    const { data } = buildBodyMeshData(cells, tables, light)
    expect(new Set(verts(data.opaque, [0, 0, 0]).filter((v) => v.normal === FACE.NY && v.x === 0).map((v) => v.sky))).toEqual(new Set([12]))
  })

  it('matches the same cells meshed in their world chunk (tone jitter, fringe variants, every vertex)', () => {
    const { data, origin } = buildBodyMeshData(cells.slice(0, 3), tables, () => FULL_SKY)
    const s = emptySnap() // chunk (1, 0, 2): origin (32, 0, 64)
    for (const c of cells.slice(0, 3)) put(s, c.x - 32, c.y, c.z - 64, c.voxel)
    const world = new Mesher().mesh(s, tables, 32, 0, 64)
    for (const layer of ['opaque', 'cutout'] as const) {
      const body = verts(data[layer], origin).map(key).sort()
      const chunk = verts(world[layer], [32, 0, 64]).map(key).sort()
      expect(body.length).toBeGreaterThan(0)
      expect(body).toEqual(chunk)
    }
  })

  it('throws RangeError for a body wider than 32 cells', () => {
    expect(() => buildBodyMeshData([{ x: 0, y: 0, z: 0, voxel: ID.stone }, { x: 32, y: 0, z: 0, voxel: ID.stone }], tables, () => FULL_SKY)).toThrow(RangeError)
  })
})

describe('createVoxelBody', () => {
  it('adds a group placed over the cells; pivot keeps world positions; ease reaches every mesh; dispose removes it', () => {
    const scene = new THREE.Scene()
    const m = () => new THREE.MeshBasicMaterial()
    let gone = 0
    const body = createVoxelBody(cells, { tables, getLight: () => FULL_SKY, materials: { opaque: m(), cutout: m(), translucent: m() }, parent: scene, reach: 0.5, onDispose: () => gone++ })
    expect(body.object.parent).toBe(scene)
    expect([body.min, body.max]).toEqual([[40, 10, 70], [42, 12, 71]])
    const meshes = [...body.object.children] as THREE.Mesh[]
    expect(meshes.map((x) => x.name)).toEqual(['elovox-voxel-body-opaque', 'elovox-voxel-body-cutout'])
    const at = (x: THREE.Object3D) => { x.updateWorldMatrix(true, false); return new THREE.Vector3().setFromMatrixPosition(x.matrixWorld).toArray() }
    // The mesh frame is chunk-centred (local − 16): its origin sits at origin + 16.
    for (const x of meshes) expect(at(x)).toEqual([56, 26, 86])
    expect((meshes[0]!.userData.uvOrigin as THREE.Vector3).toArray()).toEqual([56, 26, 86])
    expect(meshes[0]!.castShadow && meshes[1]!.castShadow).toBe(true)
    const box = meshes[1]!.geometry.boundingBox!
    expect([box.min.toArray(), box.max.toArray()]).toEqual([[-16.5, -16.5, -16.5], [-13.5, -13.5, -14.5]])
    const p = body.pivot(41, 10, 70)
    expect(p.parent).toBe(body.object)
    expect(at(p)).toEqual([41, 10, 70])
    for (const x of meshes) { expect(x.parent).toBe(p); expect(at(x)).toEqual([56, 26, 86]) }
    body.ease = 0.4
    for (const x of meshes) expect(x.userData.ease).toBe(0.4)
    body.dispose()
    body.dispose()
    expect(body.object.parent).toBeNull()
    expect(gone).toBe(1)
  })
})
