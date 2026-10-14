import { describe, expect, it } from 'vitest'
import { meshOpaqueAndCutout } from '../src/mesh/greedy.ts'
import { applyCut, type CutPlane } from '../src/mesh/meshJob.ts'
import { QuadBuilder } from '../src/mesh/quadBuilder.ts'
import { CUT_BIT, FACE, unpackA } from '../src/mesh/vertexFormat.ts'
import { PAD, padIndex, type ChunkSnapshot } from '../src/world/reader.ts'
import { packLight } from '../src/world/voxel.ts'
import { ID } from './helpers.ts'
import { assertOutwardWinding, countByNormal, emptySnap, meshTables, put } from './meshHelpers.ts'

const tables = meshTables()
function mesh(s: ChunkSnapshot, plane?: CutPlane) {
  const o = new QuadBuilder(), c = new QuadBuilder()
  meshOpaqueAndCutout(s, tables, o, c, new Int32Array(1024), plane)
  return { opaque: o.build(), cutout: c.build(), oq: o.quadCount, cq: c.quadCount }
}

describe('greedy opaque meshing', () => {
  it('emits 6 outward quads for a single block', () => {
    const s = emptySnap()
    put(s, 5, 5, 5, ID.stone)
    const m = mesh(s)
    expect(m.oq).toBe(6)
    expect(m.opaque!.vertices.length).toBe(6 * 4 * 2)
    expect(m.opaque!.indices.length).toBe(36)
    expect(m.cutout).toBeNull()
    assertOutwardWinding(m.opaque)
  })

  it('merges a 2x2x2 cube into 6 quads', () => {
    const s = emptySnap()
    for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) for (let z = 0; z < 2; z++) put(s, 10 + x, 10 + y, 10 + z, ID.stone)
    expect(mesh(s).oq).toBe(6)
  })

  it('does not merge a 3D checkerboard', () => {
    const s = emptySnap()
    let blocks = 0
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) for (let z = 0; z < 4; z++) {
      if ((x + y + z) % 2 === 0) { put(s, 4 + x, 4 + y, 4 + z, ID.stone); blocks++ }
    }
    expect(mesh(s).oq).toBe(blocks * 6)
  })

  it('meshes a 3-step staircase', () => {
    const s = emptySnap()
    for (let x = 0; x < 3; x++) for (let y = 0; y <= x; y++) put(s, 10 + x, 10 + y, 10, ID.stone)
    expect(mesh(s).oq).toBe(14)
  })

  it('stops merging at AO differences', () => {
    const s = emptySnap()
    for (let x = 0; x < 4; x++) put(s, x + 8, 0, 8, ID.stone)
    put(s, 8, 1, 8, ID.stone) // sits on block 0 and darkens block 1's top corners
    const m = mesh(s)
    expect(countByNormal(m.opaque, FACE.PY)).toBe(3) // occluder top, block 1 alone, blocks 2–3 merged
    assertOutwardWinding(m.opaque)
  })

  it('stops merging at light differences', () => {
    const s = emptySnap()
    for (let x = 0; x < 3; x++) put(s, x + 8, 0, 8, ID.stone)
    s.light[padIndex(9, 2, 9)] = packLight(5, 0) // the air above block x=8
    expect(countByNormal(mesh(s).opaque, FACE.PY)).toBe(2)
  })

  it('uses neighbour-chunk data across the border', () => {
    const s = emptySnap()
    put(s, 31, 0, 0, ID.stone)
    put(s, 32, 0, 0, ID.stone) // lives in the +X neighbour
    const m = mesh(s)
    expect(m.oq).toBe(5)
    expect(countByNormal(m.opaque, FACE.PX)).toBe(0)
  })

  it('writes the light of the cell in front of the face', () => {
    const s = emptySnap()
    put(s, 3, 3, 3, ID.stone)
    s.light[padIndex(4, 5, 4)] = packLight(9, 4) // above the block
    const m = mesh(s).opaque!
    let checked = 0
    for (let i = 0; i < m.vertices.length; i += 8) {
      if (unpackA(m.vertices[i]!).normal !== FACE.PY) continue
      const b = m.vertices[i + 1]!
      expect((b >>> 12) & 15).toBe(9)
      expect((b >>> 16) & 15).toBe(4)
      checked++
    }
    expect(checked).toBe(1) // loop steps 8 words = one quad (first vertex), one +Y quad
  })
})

describe('layer cut faces', () => {
  /** A solid 3 × 3 × 3 stone block at local 10..12, cut through its middle layer (local y 11). */
  function cutBlock() {
    const s = emptySnap()
    for (let x = 10; x < 13; x++) for (let y = 10; y < 13; y++) for (let z = 10; z < 13; z++) put(s, x, y, z, ID.stone)
    return { s, plane: applyCut(s, 0, 11, tables.opaque) }
  }
  /** The +y quads' first vertices, with their cut flag. */
  function tops(m: ReturnType<typeof mesh>) {
    const out: { y: number; cut: boolean }[] = []
    const v = m.opaque?.vertices ?? new Uint32Array()
    for (let i = 0; i < v.length; i += 8) { const a = unpackA(v[i]!); if (a.normal === FACE.PY) out.push({ y: a.y, cut: (v[i]! & CUT_BIT) !== 0 }) }
    return out
  }
  it('meshes the cut layer as if the world above were air and flags its covered tops', () => {
    const { s, plane } = cutBlock()
    expect(plane.py).toBe(12)
    const t = tops(mesh(s, plane))
    expect(t).toEqual([{ y: 12, cut: true }]) // one merged 3 × 3 quad at the middle layer's top
    for (let i = 0; i < s.voxels.length; i++) if (Math.floor(i / (PAD * PAD)) > 12) expect(s.voxels[i]).toBe(ID.air)
  })
  it('a column that was open above keeps an unflagged top, merged apart', () => {
    const { s, plane } = cutBlock()
    plane.covered[11 + 11 * PAD] = 0 // local (10, 10): padded (11, 11)
    const t = tops(mesh(s, plane))
    expect(t.filter(q => !q.cut)).toHaveLength(1)
    expect(t.filter(q => q.cut).length).toBeGreaterThan(0)
  })
  it('without a plane no face is flagged', () => {
    const s = emptySnap()
    for (let x = 10; x < 13; x++) for (let y = 10; y < 13; y++) for (let z = 10; z < 13; z++) put(s, x, y, z, ID.stone)
    const v = mesh(s).opaque!.vertices
    for (let i = 0; i < v.length; i += 2) expect(v[i]! & CUT_BIT).toBe(0)
  })
})

describe('cutout faces', () => {
  it('emits per-face quads and culls between identical cutout blocks', () => {
    const s = emptySnap()
    put(s, 2, 2, 2, ID.torch)
    expect(mesh(s).cq).toBe(6)
    const t = emptySnap()
    put(t, 2, 2, 2, ID.leaves)
    put(t, 3, 2, 2, ID.leaves)
    const m = mesh(t)
    expect(m.cq).toBe(10)
    expect(m.oq).toBe(0)
    assertOutwardWinding(m.cutout)
  })
  it('lets opaque faces show behind cutout blocks', () => {
    const s = emptySnap()
    put(s, 2, 2, 2, ID.stone)
    put(s, 3, 2, 2, ID.leaves)
    const m = mesh(s)
    expect(m.oq).toBe(6)
    expect(m.cq).toBe(5)
  })
})
