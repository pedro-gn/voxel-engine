import { describe, expect, it } from 'vitest'
import { liquidHeight, meshTranslucent } from '../src/mesh/liquid.ts'
import { Mesher, meshChunk } from '../src/mesh/mesher.ts'
import { QuadBuilder } from '../src/mesh/quadBuilder.ts'
import { FACE, unpackA } from '../src/mesh/vertexFormat.ts'
import type { ChunkSnapshot } from '../src/world/reader.ts'
import { packVoxel } from '../src/world/voxel.ts'
import { ID } from './helpers.ts'
import { assertOutwardWinding, countByNormal, emptySnap, meshTables, put } from './meshHelpers.ts'

const tables = meshTables()
const water = (level: number) => packVoxel(ID.water, level)
function mesh(s: ChunkSnapshot) {
  const q = new QuadBuilder()
  meshTranslucent(s, tables, q)
  return { m: q.build(), n: q.quadCount }
}
function topDrops(s: ChunkSnapshot): number[] {
  const { m } = mesh(s)
  const out: number[] = []
  for (let i = 0; i < m!.vertices.length; i += 2) {
    const a = unpackA(m!.vertices[i]!)
    if (a.normal === FACE.PY) out.push(a.drop)
  }
  return out
}

describe('liquid meshing', () => {
  it('maps levels to heights', () => {
    expect(liquidHeight(7)).toBeCloseTo(8 / 9)
    expect(liquidHeight(0)).toBeCloseTo(1 / 9)
  })
  it('meshes a lone full cell as 6 faces with a lowered top', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, water(7))
    const { m, n } = mesh(s)
    expect(n).toBe(6)
    expect(topDrops(s)).toEqual([2, 2, 2, 2]) // round((1 - 8/9) * 16) = 2
    assertOutwardWinding(m)
  })
  it('hides faces between stacked water and fills the lower cell to the top', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, water(7))
    put(s, 4, 5, 4, water(7))
    const { m, n } = mesh(s)
    expect(n).toBe(10)
    expect(countByNormal(m, FACE.PY)).toBe(1)
    // +X faces: lower cell (y 4..5) and upper cell (y 5..6, top lowered by 2).
    // Vertices at y === 5 are the lower face's two top vertices (drop 0)
    // and the upper face's two bottom vertices (drop 0): 4 in total.
    let checked = 0
    for (let i = 0; i < m!.vertices.length; i += 2) {
      const a = unpackA(m!.vertices[i]!)
      if (a.normal === FACE.PX && a.y === 5) {
        expect(a.drop).toBe(0)
        checked++
      }
    }
    expect(checked).toBe(4)
  })
  it('averages shared corners between neighbouring cells', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, water(7))
    put(s, 5, 4, 4, water(3))
    const { n } = mesh(s)
    expect(n).toBe(10) // no faces between the two cells
    expect(topDrops(s)).toContain(5) // shared corner: (8/9 + 4/9) / 2 → drop round(16/3) = 5
  })
  it('culls water faces against opaque blocks', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, water(7))
    put(s, 5, 4, 4, ID.stone)
    expect(mesh(s).n).toBe(5)
  })
  it('meshes glass per face and culls between glass blocks', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, ID.glass)
    put(s, 5, 4, 4, ID.glass)
    const { m, n } = mesh(s)
    expect(n).toBe(10)
    assertOutwardWinding(m)
  })
})

describe('Mesher', () => {
  it('fills all three layers and reuses its buffers', () => {
    const s = emptySnap()
    put(s, 1, 1, 1, ID.stone)
    put(s, 3, 1, 1, ID.torch)
    put(s, 5, 1, 1, water(7))
    const mesher = new Mesher()
    const a = mesher.mesh(s, tables)
    expect(a.opaque).not.toBeNull()
    expect(a.cutout).not.toBeNull()
    expect(a.translucent).not.toBeNull()
    const b = mesher.mesh(emptySnap(), tables)
    expect(b).toEqual({ opaque: null, cutout: null, translucent: null })
  })
  it('meshChunk matches Mesher output', () => {
    const s = emptySnap()
    put(s, 1, 1, 1, ID.stone)
    put(s, 2, 1, 1, ID.stone)
    put(s, 5, 1, 1, water(7))
    expect(meshChunk(s, tables)).toEqual(new Mesher().mesh(s, tables))
  })
})
