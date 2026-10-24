import { describe, expect, it } from 'vitest'
import { BlockRegistry, type BlockDef } from '../src/blocks/registry.ts'
import { meshOpaqueAndCutout, toneJitter } from '../src/mesh/greedy.ts'
import { Mesher } from '../src/mesh/mesher.ts'
import { applyCut, type CutPlane } from '../src/mesh/meshJob.ts'
import { QuadBuilder, type LayerMesh } from '../src/mesh/quadBuilder.ts'
import { meshTablesFrom, type MeshTables } from '../src/mesh/tables.ts'
import { FRINGE_BIT, unpackA, unpackB } from '../src/mesh/vertexFormat.ts'
import type { ChunkSnapshot } from '../src/world/reader.ts'
import { packVoxel } from '../src/world/voxel.ts'
import { ID, SHAPED_TEST_BLOCKS, TEST_BLOCKS } from './helpers.ts'
import { assertOutwardWinding, emptySnap, put } from './meshHelpers.ts'

function tablesWith(leaves: Partial<BlockDef>, extra: BlockDef[] = []): { tables: MeshTables; reg: BlockRegistry; layerOf: Map<string, number> } {
  const reg = new BlockRegistry([...TEST_BLOCKS.map((b) => (b.name === 'leaves' ? { ...b, ...leaves } : b)), ...extra])
  const layerOf = new Map(reg.textureNames().map((n, i) => [n, i + 1]))
  return { tables: meshTablesFrom(reg, reg.faceLayers(layerOf), undefined, reg.fringeLayers(layerOf)), reg, layerOf }
}

const { tables, layerOf } = tablesWith({ fringe: { texture: 'fringe' } })
const mesher = new Mesher()

interface Vert { x: number; y: number; z: number; normal: number; corner: number; ao: number; layer: number; sky: number; fringe: boolean }

/** Every vertex of a cutout mesh, positions decoded as the cutout material does (a fringe vertex is biased by +1). */
function verts(m: LayerMesh | null): Vert[] {
  const out: Vert[] = []
  if (!m) return out
  for (let i = 0; i < m.vertices.length; i += 2) {
    const a = unpackA(m.vertices[i]!), b = unpackB(m.vertices[i + 1]!)
    const fringe = (m.vertices[i]! & FRINGE_BIT) !== 0
    const bias = fringe ? 1 : 0
    out.push({
      x: a.x + b.fx / 16 - bias, y: a.y + b.fy / 16 - a.drop / 16 - bias, z: a.z + b.fz / 16 - bias,
      normal: a.normal, corner: a.corner, ao: a.ao, layer: b.layer, sky: b.sky, fringe,
    })
  }
  return out
}

function meshed(s: ChunkSnapshot, t = tables, plane?: CutPlane, ox = 0, oy = 0, oz = 0) {
  const m = mesher.mesh(s, t, ox, oy, oz, plane)
  const v = verts(m.cutout)
  const strips = v.filter((x) => x.fringe).length / 4
  return { m, v, strips, faces: v.length / 4 - strips }
}

describe('fringe', () => {
  it('a lone fringe leaf gets 24 strips', () => {
    const s = emptySnap()
    put(s, 5, 5, 5, ID.leaves)
    const r = meshed(s)
    expect([r.faces, r.strips]).toEqual([6, 24])
    expect(r.m.cutout!.vertices.length / 8).toBe(6 + 24)
    assertOutwardWinding(r.m.cutout)
  })

  it('no strip between leaves or on concave edges', () => {
    const s = emptySnap()
    for (let x = 5; x < 8; x++) put(s, x, 5, 5, ID.leaves)
    expect((({ faces, strips }) => [faces, strips])(meshed(s))).toEqual([14, 40])
    // A leaf diagonal to another: the two edges facing it on each leaf stay bare.
    const d = emptySnap()
    put(d, 5, 5, 5, ID.leaves)
    put(d, 6, 6, 5, ID.leaves)
    expect((({ faces, strips }) => [faces, strips])(meshed(d))).toEqual([12, 44])
  })

  it('a strip beside an opaque block is not emitted', () => {
    const s = emptySnap()
    for (let x = 3; x < 8; x++) for (let z = 3; z < 8; z++) put(s, x, 4, z, ID.stone)
    put(s, 5, 5, 5, ID.leaves)
    const r = meshed(s)
    expect([r.faces, r.strips]).toEqual([5, 16])
  })

  it('strips extend outward by width, down-hanging by hang', () => {
    const s = emptySnap()
    put(s, 5, 5, 5, ID.leaves)
    const v = meshed(s).v.filter((x) => x.fringe)
    const top = v.filter((x) => x.normal === 2)
    expect(Math.max(...top.map((x) => x.x))).toBe(6 + 5 / 16)
    expect(Math.min(...top.map((x) => x.z))).toBe(5 - 5 / 16)
    expect(top.every((x) => x.y === 6)).toBe(true) // in the face's plane
    const side = v.filter((x) => x.normal === 0)
    expect(Math.min(...side.map((x) => x.y))).toBe(5 - 7 / 16)
    expect(Math.max(...side.map((x) => x.y))).toBe(6 + 5 / 16)
    expect(side.every((x) => x.x === 6)).toBe(true)
    // Custom widths, quantised to sixteenths.
    const wide = tablesWith({ fringe: { texture: 'fringe', width: 0.375, hang: 0.625 } }).tables
    const w = meshed(s, wide).v.filter((x) => x.fringe && x.normal === 0)
    expect([Math.min(...w.map((x) => x.y)), Math.max(...w.map((x) => x.y))]).toEqual([5 - 0.625, 6.375])
  })

  it('a strip at local 0 decodes to a negative coordinate', () => {
    const s = emptySnap()
    put(s, 0, 0, 0, ID.leaves)
    const v = meshed(s).v.filter((x) => x.fringe)
    expect(Math.min(...v.map((x) => x.x))).toBe(-5 / 16)
    expect(Math.min(...v.map((x) => x.z))).toBe(-5 / 16)
    expect(Math.min(...v.map((x) => x.y))).toBe(-7 / 16)
    const t = emptySnap()
    put(t, 31, 31, 31, ID.leaves)
    expect(Math.max(...meshed(t).v.map((x) => x.y))).toBe(32 + 5 / 16)
  })

  it('uv comes from corners', () => {
    const s = emptySnap()
    put(s, 5, 5, 5, ID.leaves)
    const v = meshed(s).v.filter((x) => x.fringe)
    const fringeLayer = layerOf.get('fringe')!
    for (const x of v) {
      const u = x.corner === 1 || x.corner === 2 ? 1 : 0, vv = x.corner >= 2 ? 1 : 0
      expect([[0, 0], [1, 0], [1, 1], [0, 1]]).toContainEqual([u, vv])
      const onGrid = Number.isInteger(x.x) && Number.isInteger(x.y) && Number.isInteger(x.z)
      expect(onGrid).toBe(vv === 0) // v = 0 on the block edge, 1 at the strip's outer edge
      expect(x.layer).toBe(fringeLayer)
      expect(x.ao).toBe(0) // no occlusion
      expect(x.sky).toBe(15) // the face's light
    }
  })

  it('neighbours across the chunk border count', () => {
    const s = emptySnap()
    put(s, 31, 5, 5, ID.leaves)
    put(s, 32, 5, 5, ID.leaves) // next chunk, via the apron
    const r = meshed(s)
    expect([r.faces, r.strips]).toEqual([5, 16])
    expect(Math.max(...r.v.map((x) => x.x))).toBe(32)
    const d = emptySnap()
    put(d, 31, 5, 5, ID.leaves)
    put(d, 32, 6, 5, ID.leaves) // diagonal, across the border
    expect(meshed(d).strips).toBe(22)
  })

  it('the layer cut slices strips', () => {
    const s = emptySnap()
    for (let x = 4; x < 7; x++) for (let y = 10; y < 13; y++) for (let z = 4; z < 7; z++) put(s, x, y, z, ID.leaves)
    const plane = applyCut(s, 0, 11, tables.blocksLight)
    const r = meshed(s, tables, plane)
    expect(r.strips).toBeGreaterThan(0)
    // Nothing above the cut layer's top (y = 12): no cell above it, no strip of the cut layer poking up through it.
    expect(Math.max(...r.v.map((x) => x.y))).toBe(12)
    // A crown under the cut keeps its upward strips.
    const open = emptySnap()
    for (let x = 4; x < 7; x++) for (let y = 10; y < 12; y++) for (let z = 4; z < 7; z++) put(open, x, y, z, ID.leaves)
    const p2 = applyCut(open, 0, 11, tables.blocksLight)
    expect(Math.max(...meshed(open, tables, p2).v.map((x) => x.y))).toBe(12 + 5 / 16)
  })

  it('no strip rises above the cut plane where the cut removed the diagonal', () => {
    // The reviewer's repro: a leaf on the cut layer, a leaf above it diagonally (+z); the cut removes the upper leaf.
    const s = emptySnap()
    put(s, 5, 7, 5, ID.leaves)
    put(s, 5, 8, 6, ID.leaves)
    const plane = applyCut(s, 0, 7, tables.blocksLight)
    const above = meshed(s, tables, plane).v.filter((x) => x.fringe && x.y > 8)
    // The +z face's up strip existed only because the cut removed its diagonal: gone. The other three side faces' up
    // strips are the uncut world's too (nothing above them was cut) and stay, as for a crown that ends at the cut layer.
    expect(above.filter((x) => x.normal === 4)).toEqual([])
    expect(above.length / 2).toBe(3)
  })

  it('no strip grows into a shaped block (slab, stair) beyond the edge or diagonal to it', () => {
    const shaped = tablesWith({ fringe: { texture: 'fringe' } }, SHAPED_TEST_BLOCKS).tables
    const slab = emptySnap()
    put(slab, 5, 5, 5, ID.leaves)
    put(slab, 6, 4, 5, ID.stone_slab) // diagonal to the leaf's bottom face's +x edge and its +x face's bottom edge
    expect((({ faces, strips }) => [faces, strips])(meshed(slab, shaped))).toEqual([6, 22])
    const stair = emptySnap()
    put(stair, 5, 5, 5, ID.leaves)
    put(stair, 6, 5, 5, ID.stone_stair) // beyond the +x edge of the top, bottom, +z and -z faces
    expect((({ faces, strips }) => [faces, strips])(meshed(stair, shaped))).toEqual([6, 20])
  })

  it('the cutout pass reports whether it emitted a face of a fringe block (the fringe pass runs only then)', () => {
    const run = (s: ChunkSnapshot, t = tables) => meshOpaqueAndCutout(s, t, new QuadBuilder(), new QuadBuilder(), new Int32Array(1024))
    const leaf = emptySnap()
    put(leaf, 5, 5, 5, ID.leaves)
    expect(run(leaf)).toBe(true)
    expect(run(leaf, tablesWith({}).tables)).toBe(false) // no fringe in the world
    const torch = emptySnap()
    put(torch, 5, 5, 5, ID.torch)
    put(torch, 9, 5, 5, ID.stone)
    expect(run(torch)).toBe(false) // cutout faces, but none of a fringe block
    const buried = emptySnap()
    for (let x = 4; x < 7; x++) for (let y = 4; y < 7; y++) for (let z = 4; z < 7; z++) put(buried, x, y, z, ID.stone)
    put(buried, 5, 5, 5, ID.leaves)
    expect(run(buried)).toBe(false) // a fringe block with no exposed face
  })

  it('fringe strips carry tone bits like the face', () => {
    const toned = tablesWith({ fringe: { texture: 'fringe' }, tone: { dark: [0.5, 0.6, 0.5], light: [1.2, 1.2, 1] } })
    const s = emptySnap()
    put(s, 3, 4, 5, packVoxel(ID.leaves, 3))
    const r = meshed(s, toned.tables, undefined, 32, 0, 64)
    const fl = toned.layerOf.get('fringe')!
    const strips = r.v.filter((x) => x.fringe)
    expect(strips.length).toBe(96)
    for (const x of strips) expect([x.layer & 0xff, (x.layer >> 8) & 3, x.layer >> 10]).toEqual([fl, 3, toneJitter(35, 4, 69)])
    expect(toned.reg.toneLayers(toned.layerOf).jitter[fl]).toBeCloseTo(0.035) // the fringe texture takes the block's tone
  })

  it('a world without fringe emits no strip and skips the pass', () => {
    const plain = tablesWith({}).tables
    expect(plain.hasFringe).toBe(false)
    const s = emptySnap()
    put(s, 5, 5, 5, ID.leaves)
    expect(meshed(s, plain).strips).toBe(0)
    const t = emptySnap()
    put(t, 5, 5, 5, ID.torch) // a fringe world, but no fringe block in this chunk
    expect(meshed(t).strips).toBe(0)
  })
})
