import { describe, expect, it } from 'vitest'
import { BlockRegistry } from '../src/blocks/registry.ts'
import { stairState } from '../src/blocks/shapes.ts'
import { applyCut } from '../src/mesh/meshJob.ts'
import { Mesher } from '../src/mesh/mesher.ts'
import type { LayerMesh } from '../src/mesh/quadBuilder.ts'
import { meshTablesFrom } from '../src/mesh/tables.ts'
import { CUT_BIT, FACE, FACE_NORMALS, unpackA, unpackB } from '../src/mesh/vertexFormat.ts'
import { padIndex } from '../src/world/reader.ts'
import { packVoxel } from '../src/world/voxel.ts'
import { surfaceSnap } from '../bench/surface.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'
import { assertOutwardWinding, countByNormal, emptySnap, meshTables, put } from './meshHelpers.ts'

const tables = meshTables()
const mesher = new Mesher()
const meshOf = (s: ReturnType<typeof emptySnap>, t = tables) => mesher.mesh(s, t).opaque

interface Quad { normal: number; pts: [number, number, number][]; sky: number; cut: boolean }
/** Every quad of a mesh, its corners decoded as (x + fx/16, y + fy/16 − drop/16, z + fz/16). */
function quads(m: LayerMesh | null): Quad[] {
  const out: Quad[] = []
  if (!m) return out
  for (let i = 0; i < m.vertices.length; i += 8) {
    const pts: [number, number, number][] = []
    let normal = 0, sky = 0, cut = false
    for (let k = 0; k < 4; k++) {
      const wa = m.vertices[i + k * 2]!, a = unpackA(wa), b = unpackB(m.vertices[i + k * 2 + 1]!)
      pts.push([a.x + b.fx / 16, a.y + b.fy / 16 - a.drop / 16, a.z + b.fz / 16])
      normal = a.normal; sky = b.sky; cut = (wa & CUT_BIT) !== 0
    }
    out.push({ normal, pts, sky, cut })
  }
  return out
}
const positions = (m: LayerMesh | null) => quads(m).flatMap((q) => q.pts)
const area = (q: Quad) => {
  const [p0, p1, , p3] = q.pts
  const e1 = p1!.map((v, i) => v - p0![i]!), e2 = p3!.map((v, i) => v - p0![i]!)
  return Math.hypot(e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!)
}
const minOf = (q: Quad, axis: number) => Math.min(...q.pts.map((p) => p[axis]!))
const maxOf = (q: Quad, axis: number) => Math.max(...q.pts.map((p) => p[axis]!))
/** The quads drawn by cell (x, y, z): their centre, nudged against the normal, lies inside it. */
function quadsOfCell(m: LayerMesh | null, x: number, y: number, z: number): Quad[] {
  return quads(m).filter((q) => {
    const n = FACE_NORMALS[q.normal]!
    const c = [0, 1, 2].map((i) => q.pts.reduce((s, p) => s + p[i]!, 0) / 4 - n[i]! * 0.01)
    return c[0]! > x && c[0]! < x + 1 && c[1]! > y && c[1]! < y + 1 && c[2]! > z && c[2]! < z + 1
  })
}
/** A cell's quads as sorted strings relative to the cell, for comparing two placements. */
const shapeKey = (qs: Quad[], x: number, y: number, z: number) =>
  qs.map((q) => `${q.normal}:` + q.pts.map((p) => `${p[0] - x},${p[1] - y},${p[2] - z}`).sort().join(' ')).sort()

describe('shaped blocks in the chunk mesh', () => {
  it('a bottom slab on stone draws 5 faces, its top at y + 0.5', () => {
    const s = emptySnap()
    put(s, 5, 4, 5, ID.stone)
    put(s, 5, 5, 5, ID.stone_slab)
    const slab = quadsOfCell(meshOf(s), 5, 5, 5)
    expect(slab).toHaveLength(5)
    expect(slab.filter((q) => q.normal === FACE.NY)).toHaveLength(0)
    const tops = slab.filter((q) => q.normal === FACE.PY)
    expect(tops).toHaveLength(1)
    for (const p of tops[0]!.pts) expect(p[1]).toBe(5.5)
  })

  it('stone beside a slab still draws its face', () => {
    const s = emptySnap()
    put(s, 5, 5, 5, ID.stone_slab)
    put(s, 6, 5, 5, ID.stone)
    expect(quadsOfCell(meshOf(s), 6, 5, 5).filter((q) => q.normal === FACE.NX)).toHaveLength(1)
  })

  it('a straight stair has no stray faces', () => {
    const s = emptySnap()
    put(s, 5, 5, 5, packVoxel(ID.stone_stair, stairState(0)))
    const m = meshOf(s)
    assertOutwardWinding(m)
    const tops = quads(m).filter((q) => q.normal === FACE.PY)
    expect(tops.reduce((a, q) => a + area(q), 0)).toBe(1)
  })

  it('a hip roof corner draws an outer corner', () => {
    const s = emptySnap()
    put(s, 5, 6, 5, packVoxel(ID.stone_stair, stairState(1)))
    put(s, 5, 6, 6, packVoxel(ID.stone_stair, stairState(0)))
    put(s, 6, 6, 5, packVoxel(ID.stone_stair, stairState(1)))
    const tops = quadsOfCell(meshOf(s), 5, 6, 5).filter((q) => q.normal === FACE.PY && q.pts[0]![1] === 7)
    expect(tops.reduce((a, q) => a + area(q), 0)).toBe(0.25)
    for (const q of tops) {
      expect([minOf(q, 0), maxOf(q, 0), minOf(q, 2), maxOf(q, 2)].every((v, i) => (i % 2 === 0 ? v >= 5.5 : v <= 6))).toBe(true)
    }
  })

  it('a corner across a chunk border', () => {
    const place = (x: number) => {
      const s = emptySnap()
      put(s, x, 6, 5, packVoxel(ID.stone_stair, stairState(0)))
      put(s, x + 1, 6, 5, packVoxel(ID.stone_stair, stairState(1))) // its high side: decides an outer corner
      const qs = quadsOfCell(meshOf(s), x, 6, 5)
      return { key: shapeKey(qs, x, 6, 5), high: qs.filter((q) => q.normal === FACE.PY && q.pts[0]![1] === 7).reduce((a, q) => a + area(q), 0) }
    }
    const inside = place(20)
    expect(inside.high).toBe(0.25) // an outer corner: only a quadrant on top
    expect(place(31)).toEqual(inside)
  })

  it("a cube face into a stair cell keeps the stair's neighbours' light", () => {
    const s = emptySnap()
    put(s, 5, 5, 5, packVoxel(ID.stone_stair, stairState(0)))
    put(s, 6, 5, 5, ID.stone)
    s.light[padIndex(6, 6, 6)] = 0
    s.light[padIndex(7, 6, 6)] = 0
    const face = quadsOfCell(meshOf(s), 6, 5, 5).filter((q) => q.normal === FACE.NX)
    expect(face).toHaveLength(1)
    expect(face[0]!.sky).toBeGreaterThanOrEqual(14)
  })

  it("a stair's step facing a cube is lit from the stair's own cell, not the cube's", () => {
    const s = emptySnap()
    put(s, 5, 5, 5, packVoxel(ID.stone_stair, stairState(2))) // high half on −x: the step faces +x, into the stone
    put(s, 6, 5, 5, ID.stone)
    s.light[padIndex(6, 6, 6)] = 0
    s.light[padIndex(7, 6, 6)] = 0
    const step = quadsOfCell(meshOf(s), 5, 5, 5).filter((q) => q.normal === FACE.PX && minOf(q, 0) === 5.5)
    expect(step).toHaveLength(1)
    expect(step[0]!.sky).toBeGreaterThanOrEqual(14)
  })

  it('no shapes, no change', () => {
    const plain = new BlockRegistry(TEST_BLOCKS.slice(0, 7))
    const t = meshTablesFrom(plain, plain.faceLayers(new Map(plain.textureNames().map((n, i) => [n, i + 1]))))
    expect(t.hasShapes).toBe(false)
    expect(tables.hasShapes).toBe(true)
    const a = new Mesher().mesh(surfaceSnap(), tables), b = new Mesher().mesh(surfaceSnap(), t)
    expect(a.opaque!.vertices).toEqual(b.opaque!.vertices)
    expect(a.opaque!.indices).toEqual(b.opaque!.indices)
  })

  it('drops faces a neighbouring shape covers whatever its form', () => {
    const s = emptySnap()
    put(s, 5, 5, 5, packVoxel(ID.stone_stair, stairState(0)))
    put(s, 5, 5, 6, packVoxel(ID.stone_stair, stairState(0)))
    put(s, 5, 4, 5, packVoxel(ID.stone_stair, stairState(2, true)))
    const m = meshOf(s)
    const a = quadsOfCell(m, 5, 5, 5)
    expect(a.filter((q) => q.normal === FACE.PZ && maxOf(q, 1) <= 5.5)).toHaveLength(0) // its slab part against the next one's
    expect(a.filter((q) => q.normal === FACE.NY)).toHaveLength(0) // its bottom on the upside-down stair's top
    expect(quadsOfCell(m, 5, 4, 5).filter((q) => q.normal === FACE.PY)).toHaveLength(0)
    expect(quadsOfCell(m, 5, 5, 6).filter((q) => q.normal === FACE.NZ && maxOf(q, 1) <= 5.5)).toHaveLength(0)
    assertOutwardWinding(m)
  })

  it('the layer cut hides shapes above it and flags none', () => {
    const s = emptySnap()
    put(s, 5, 5, 5, packVoxel(ID.stone_stair, stairState(0)))
    put(s, 5, 6, 5, packVoxel(ID.stone_stair, stairState(2)))
    const plane = applyCut(s, 0, 5, tables.blocksLight)
    const m = new Mesher().mesh(s, tables, 0, 0, 0, plane).opaque
    expect(positions(m).length).toBeGreaterThan(0)
    expect(Math.max(...positions(m).map((p) => p[1]))).toBeLessThanOrEqual(6)
    expect(quads(m).some((q) => q.cut)).toBe(false)
    expect(countByNormal(m, FACE.PY)).toBe(2) // the lower stair, whole
  })
})
