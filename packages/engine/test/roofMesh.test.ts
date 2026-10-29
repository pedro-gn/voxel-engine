import { describe, expect, it } from 'vitest'
import { ROOF_REACH, roofState } from '../src/blocks/roofs.ts'
import type { Facing } from '../src/blocks/shapes.ts'
import { applyCut } from '../src/mesh/meshJob.ts'
import { Mesher } from '../src/mesh/mesher.ts'
import type { LayerMesh } from '../src/mesh/quadBuilder.ts'
import { TILT_NORMAL, unpackA, unpackB } from '../src/mesh/vertexFormat.ts'
import { padIndex } from '../src/world/reader.ts'
import { packVoxel } from '../src/world/voxel.ts'
import { ID, ROOF_ID, roofRegistry } from './helpers.ts'
import { assertOutwardWinding, emptySnap, normalOf, put, roofMeshTables } from './meshHelpers.ts'

const tables = roofMeshTables()
const mesher = new Mesher()
const slope = (f: Facing, id: number = ROOF_ID.tile_roof) => packVoxel(id, roofState('slope', f))

interface Quad { pts: [number, number, number][]; n: readonly [number, number, number]; tilted: boolean; sky: number }
function quads(m: LayerMesh | null): Quad[] {
  const out: Quad[] = []
  if (!m) return out
  for (let i = 0; i < m.vertices.length; i += 8) {
    const pts: [number, number, number][] = []
    for (let k = 0; k < 4; k++) {
      const a = unpackA(m.vertices[i + k * 2]!), b = unpackB(m.vertices[i + k * 2 + 1]!)
      pts.push([a.x + b.fx / 16, a.y + b.fy / 16 - a.drop / 16, a.z + b.fz / 16])
    }
    out.push({ pts, n: normalOf(m.vertices[i]!), tilted: unpackA(m.vertices[i]!).normal === TILT_NORMAL, sky: unpackB(m.vertices[i + 1]!).sky })
  }
  return out
}

describe('roof cells in the chunk mesh', () => {
  it('a lone slope emits tilted quads', () => {
    const s = emptySnap()
    put(s, 5, 5, 5, slope(0))
    const m = mesher.mesh(s, tables).opaque
    const qs = quads(m)
    expect(qs.some((q) => q.tilted && q.n[0] !== 0 && q.n[1] !== 0)).toBe(true)
    assertOutwardWinding(m)
    const isBottom = (q: Quad) => q.n[1] === -1 && q.pts.every((p) => p[1] === 5)
    expect(qs.filter(isBottom)).toHaveLength(1)
    put(s, 5, 4, 5, ID.stone)
    expect(quads(mesher.mesh(s, tables).opaque).filter(isBottom)).toHaveLength(0)
  })

  it('overhang survives the chunk edge', () => {
    const s = emptySnap()
    put(s, 0, 5, 5, slope(0)) // eave toward −x, hanging below the chunk's x = 0
    put(s, 31, 5, 9, slope(2)) // eave toward +x, past x = 32
    const xs = quads(mesher.mesh(s, tables).opaque).flatMap((q) => q.pts.map((p) => p[0]))
    expect(Math.min(...xs)).toBe(-6 / 16)
    expect(Math.max(...xs)).toBe(32 + 6 / 16)
    expect(roofRegistry().fringeReach).toBeGreaterThanOrEqual(ROOF_REACH)
    expect(ROOF_REACH).toBeGreaterThanOrEqual(6 / 16)
  })

  it('cut removes roof above it', () => {
    // A gable across z on stone walls: eave rows at y 10, upper rows and the ridge at y 11; two blocks of roof.
    const gable = () => {
      const s = emptySnap()
      for (let x = 3; x < 6; x++) {
        for (const z of [4, 8]) for (let y = 7; y < 10; y++) put(s, x, y, z, ID.stone)
        put(s, x, 10, 4, slope(1, x === 4 ? ROOF_ID.thatch_roof : ROOF_ID.tile_roof)); put(s, x, 10, 8, slope(3))
        put(s, x, 11, 5, slope(1)); put(s, x, 11, 7, slope(3))
        put(s, x, 11, 6, packVoxel(ROOF_ID.tile_roof, roofState('ridge', 1)))
      }
      return s
    }
    const whole = quads(mesher.mesh(gable(), tables).opaque)
    expect(Math.max(...whole.flatMap((q) => q.pts.map((p) => p[1])))).toBeGreaterThan(12)
    const s = gable()
    const m = mesher.mesh(s, tables, 0, 0, 0, applyCut(s, 0, 10, tables.blocksLight)).opaque
    assertOutwardWinding(m)
    const ys = quads(m).flatMap((q) => q.pts.map((p) => p[1]))
    expect(Math.max(...ys)).toBeLessThanOrEqual(11 + ROOF_REACH)
    // The eave rows are still drawn: their tilted boards between y 10 and 11.
    expect(quads(m).filter((q) => q.tilted && q.n[1] > 0 && q.pts.every((p) => p[1] >= 10 && p[1] <= 11 + 2 / 16)).length).toBeGreaterThan(0)
  })

  it("faces looking into a dark room take its light; boards keep the roof cell's", () => {
    const s = emptySnap()
    put(s, 5, 10, 5, slope(0))
    s.light[padIndex(6, 11, 6)] = 0 // the roof cell holds no light, as the sim stores it
    s.light[padIndex(6, 10, 6)] = 0 // the dark room under it
    const qs = quads(mesher.mesh(s, tables).opaque)
    const bottom = qs.filter((q) => q.n[1] === -1 && q.pts.every((p) => p[1] === 10))
    expect(bottom.map((q) => q.sky)).toEqual([0])
    expect(qs.filter((q) => q.tilted && q.n[1] > 0).every((q) => q.sky === 15)).toBe(true)
  })

  it('no trim pokes into a solid shaped neighbour; the side is closed', () => {
    // A slope facing +x at (5, 10, 5), a stone post on its right (+z).
    const s = emptySnap()
    put(s, 5, 10, 5, slope(0))
    put(s, 5, 10, 6, ID.stone_post)
    const qs = quads(mesher.mesh(s, tables).opaque)
    expect(qs.filter((q) => q.pts.some((p) => p[2] === 6 + 2 / 16))).toEqual([]) // no barge board 2/16 into the post's cell
    expect(qs.some((q) => q.n[2] === 1 && q.pts.every((p) => p[2] === 6) && q.pts.some((p) => p[0] > 5 && p[1] > 10))).toBe(true)
  })

  it('a ridge closes its end against a roof that is not a ridge on its axis', () => {
    // A ridge facing +z runs along x; its end at x = 6 against (6, 10, 5).
    const endFaces = (nb: number) => {
      const s = emptySnap()
      put(s, 5, 10, 5, packVoxel(ROOF_ID.tile_roof, roofState('ridge', 1)))
      put(s, 6, 10, 5, nb)
      return quads(mesher.mesh(s, tables).opaque).filter((q) => q.n[0] === 1 && q.pts.every((p) => p[0] === 6) && q.pts.some((p) => p[1] > 11.4)).length
    }
    expect(endFaces(packVoxel(ROOF_ID.tile_roof, roofState('apex')))).toBeGreaterThan(0)
    expect(endFaces(slope(0))).toBeGreaterThan(0)
    expect(endFaces(slope(2))).toBeGreaterThan(0)
    expect(endFaces(packVoxel(ROOF_ID.tile_roof, roofState('ridge', 3)))).toBe(0)
  })
})
