import { describe, expect, it } from 'vitest'
import { meshTranslucent } from '../src/mesh/liquid.ts'
import { QuadBuilder, type LayerMesh } from '../src/mesh/quadBuilder.ts'
import { FACE, LIQUID_DEEP, packA, unpackA } from '../src/mesh/vertexFormat.ts'
import { BLEND_SECONDS, NEW_DROP, blendFrom, blendedDrop, isTopRow, type LiquidBlendState } from '../src/render/liquidBlend.ts'
import type { ChunkSnapshot } from '../src/world/reader.ts'
import { packVoxel } from '../src/world/voxel.ts'
import { ID } from './helpers.ts'
import { emptySnap, meshTables, put } from './meshHelpers.ts'

/** Packs word-A/word-B pairs (word B is irrelevant to blending: 0). */
function verts(...as: number[]): Uint32Array {
  const out = new Uint32Array(as.length * 2)
  as.forEach((a, i) => { out[i * 2] = a })
  return out
}

function state(vertices: Uint32Array, prevDrop: number[], t0: number[]): LiquidBlendState {
  return { vertices, prevDrop: Float32Array.from(prevDrop), t0: Float32Array.from(t0) }
}

describe('blendedDrop', () => {
  it('holds prevDrop before t0, reaches drop after BLEND_SECONDS, and is linear in between', () => {
    expect(BLEND_SECONDS).toBe(0.1)
    expect(NEW_DROP).toBe(16)
    expect(blendedDrop(16, 4, 10, 9)).toBe(16)
    expect(blendedDrop(16, 4, 10, 10)).toBe(16)
    expect(blendedDrop(16, 4, 10, 10 + BLEND_SECONDS / 2)).toBeCloseTo(10)
    expect(blendedDrop(16, 4, 10, 10 + BLEND_SECONDS)).toBeCloseTo(4) // 10.1 − 10 is not exactly 0.1 in doubles
    expect(blendedDrop(16, 4, 10, 20)).toBe(4)
  })
})

describe('isTopRow', () => {
  it('marks every corner of a +Y face and none of a -Y face', () => {
    for (let c = 0; c < 4; c++) {
      expect(isTopRow(packA(1, 2, 3, FACE.PY, 0, c, 5))).toBe(true)
      expect(isTopRow(packA(1, 2, 3, FACE.NY, 0, c))).toBe(false)
    }
  })
  it('marks exactly the two top corners (2 and 3) of each side face', () => {
    for (const f of [FACE.PX, FACE.NX, FACE.PZ, FACE.NZ]) {
      const top = [0, 1, 2, 3].filter((c) => isTopRow(packA(1, 2, 3, f, 0, c)))
      expect(top, `face ${f}`).toEqual([2, 3])
    }
  })
})

describe('blendFrom', () => {
  it('starts a vertex at the drop prev displays at its position once prev has fully blended', () => {
    const prev = state(verts(packA(4, 6, 4, FACE.PY, 0, 0, 3)), [16], [1])
    const r = blendFrom(prev, verts(packA(4, 6, 4, FACE.PY, 0, 0, 9)), 5)
    expect(r.prevDrop[0]).toBe(3)
  })

  it('retargets mid-blend from the in-between displayed drop', () => {
    const prev = state(verts(packA(4, 6, 4, FACE.PY, 0, 2, 4)), [12], [1])
    const now = 1 + BLEND_SECONDS / 4
    const r = blendFrom(prev, verts(packA(4, 6, 4, FACE.PY, 0, 2, 1)), now)
    expect(r.prevDrop[0]).toBeCloseTo(10) // 12 + (4 − 12) · 0.25, neither 4 (target) nor 12 (prevDrop)
  })

  it('starts top-row vertices at absent positions at NEW_DROP and bottom-row vertices at their own drop', () => {
    const prev = state(verts(packA(4, 6, 4, FACE.PY, 0, 0, 3)), [3], [0])
    const next = verts(
      packA(5, 6, 4, FACE.PY, 0, 1, 2), // top row, new position
      packA(4, 5, 4, FACE.PX, 0, 0), // bottom row of a side face
      packA(4, 6, 4, FACE.PX, 0, 3, 7), // top row of a side face, at prev's position
    )
    const r = blendFrom(prev, next, 9)
    expect([...r.prevDrop]).toEqual([NEW_DROP, 0, 3])
    const fresh = blendFrom(null, next, 9)
    expect([...fresh.prevDrop]).toEqual([NEW_DROP, 0, NEW_DROP])
  })

  it('lets the first of two prev vertices at one position win', () => {
    const prev = state(verts(
      packA(4, 6, 4, FACE.PY, 0, 0, 2), // top face corner
      packA(4, 6, 4, FACE.NX, 0, 2, 2), // side face top corner at the same position, displaying another height
    ), [5, 14], [0, 3])
    const r = blendFrom(prev, verts(packA(4, 6, 4, FACE.PY, 0, 0, 2)), 3)
    expect(r.prevDrop[0]).toBe(2) // first: fully blended to 2 (second would display 14)
    const swapped = state(verts(prev.vertices[2]!, prev.vertices[0]!), [14, 5], [3, 0])
    expect(blendFrom(swapped, verts(packA(4, 6, 4, FACE.PY, 0, 0, 2)), 3).prevDrop[0]).toBe(14)
  })

  it('matches positions whatever the ao bits hold (the liquid deep flag)', () => {
    expect(isTopRow(packA(4, 6, 4, FACE.PY, LIQUID_DEEP, 0, 3))).toBe(true)
    const prev = state(verts(packA(4, 6, 4, FACE.PY, 0, 0, 3)), [3], [0])
    expect(blendFrom(prev, verts(packA(4, 6, 4, FACE.PY, LIQUID_DEEP, 0, 9)), 5).prevDrop[0]).toBe(3)
    const deepPrev = state(verts(packA(4, 6, 4, FACE.PX, LIQUID_DEEP, 3, 5)), [5], [0])
    expect(blendFrom(deepPrev, verts(packA(4, 6, 4, FACE.PY, 0, 0, 9)), 5).prevDrop[0]).toBe(5)
  })

  it('stamps t0 = now on every vertex', () => {
    const next = verts(packA(1, 2, 1, FACE.PY, 0, 0, 1), packA(1, 1, 1, FACE.NY, 0, 0))
    expect([...blendFrom(null, next, 2.5).t0]).toEqual([2.5, 2.5])
  })

  it('starts a full-height top-row vertex (drop 0) at 0, whatever prev displayed there', () => {
    const prev = state(verts(packA(4, 6, 4, FACE.PY, 0, 0, 7)), [7], [0])
    const next = verts(packA(4, 6, 4, FACE.PY, 0, 0, 0), packA(5, 6, 4, FACE.PX, 0, 3, 0))
    expect([...blendFrom(prev, next, 5).prevDrop]).toEqual([0, 0]) // not 7 (prev) nor NEW_DROP (absent)
  })
})

describe('blended liquid mesh', () => {
  const tables = meshTables()
  function liquidMesh(s: ChunkSnapshot): LayerMesh {
    const t = new QuadBuilder(), l = new QuadBuilder()
    meshTranslucent(s, tables, t, l)
    return l.build()!
  }
  /** Edges used by an odd number of displayed triangles (open), as "x,y,z|x,y,z" with heights at `now`. */
  function openEdges(m: LayerMesh, b: { prevDrop: Float32Array; t0: Float32Array }, now: number): string[] {
    const pos = (vi: number) => {
      const a = unpackA(m.vertices[vi * 2]!)
      return `${a.x},${(a.y - blendedDrop(b.prevDrop[vi]!, a.drop, b.t0[vi]!, now) / 16).toFixed(4)},${a.z}`
    }
    const count = new Map<string, number>()
    for (let i = 0; i < m.indices.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        const k = [pos(m.indices[i + e]!), pos(m.indices[i + (e + 1) % 3]!)].sort().join('|')
        count.set(k, (count.get(k) ?? 0) + 1)
      }
    }
    return [...count].filter(([, n]) => n % 2 === 1).map(([k]) => k)
  }

  // Distilled from the flood's plunge pool: a full cell in a level-2 film gets a cell stacked on it. The film's corners
  // beside it become full (drop 0) and must meet the new cell's side faces, whose bottom row is pinned at the film top.
  it('stays closed while a stacked cell appears on a film', () => {
    const s = emptySnap()
    for (let x = 0; x < 10; x++) for (let z = 0; z < 10; z++) put(s, x, 3, z, packVoxel(ID.stone))
    for (let x = 3; x <= 5; x++) for (let z = 3; z <= 5; z++) put(s, x, 4, z, packVoxel(ID.water, 2))
    put(s, 4, 4, 4, packVoxel(ID.water, 7))
    const before = liquidMesh(s)
    const settled = blendFrom(null, before.vertices, 0)
    put(s, 4, 5, 4, packVoxel(ID.water, 5))
    const after = liquidMesh(s)
    const now = 1
    const b = blendFrom({ vertices: before.vertices, prevDrop: settled.prevDrop, t0: settled.t0 }, after.vertices, now)
    // The only open edges are the film's outline on the stone floor (y = 4): water faces against stone are culled.
    const onFloor = (k: string) => k.split('|').every((p) => p.split(',')[1] === '4.0000')
    for (const at of [now, now + BLEND_SECONDS / 2, now + BLEND_SECONDS]) {
      expect(openEdges(after, b, at).filter((k) => !onFloor(k)), `t = ${at}`).toEqual([])
    }
  })
})
