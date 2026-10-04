import { describe, expect, it } from 'vitest'
import { liquidHeight, meshTranslucent } from '../src/mesh/liquid.ts'
import { Mesher, meshChunk } from '../src/mesh/mesher.ts'
import { QuadBuilder } from '../src/mesh/quadBuilder.ts'
import { BlockRegistry, defineBlock } from '../src/blocks/registry.ts'
import { meshTablesFrom } from '../src/mesh/tables.ts'
import { FACE, FLOW, unpackA, unpackFlow } from '../src/mesh/vertexFormat.ts'
import type { ChunkSnapshot } from '../src/world/reader.ts'
import { packVoxel } from '../src/world/voxel.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'
import { assertOutwardWinding, countByNormal, emptySnap, meshTables, put } from './meshHelpers.ts'

const tables = meshTables()
const water = (level: number) => packVoxel(ID.water, level)
function both(s: ChunkSnapshot) {
  const t = new QuadBuilder(), l = new QuadBuilder()
  meshTranslucent(s, tables, t, l)
  return { translucent: t, liquid: l }
}
/** Liquid-layer output (water). */
function mesh(s: ChunkSnapshot) {
  const { liquid } = both(s)
  return { m: liquid.build(), n: liquid.quadCount }
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
  it('meshes a lone full cell as 6 faces with a lowered top, in the liquid layer only', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, water(7))
    const { translucent } = both(s)
    const { m, n } = mesh(s)
    expect(n).toBe(6)
    expect(translucent.quadCount).toBe(0)
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
    expect(mesh(s).n).toBe(10)
    expect(topDrops(s)).toContain(5) // (8/9 + 4/9) / 2 → drop round(16/3) = 5
  })
  it('culls water faces against opaque blocks', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, water(7))
    put(s, 5, 4, 4, ID.stone)
    expect(mesh(s).n).toBe(5)
  })
  it('meshes glass per face in the translucent layer and culls between glass blocks', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, ID.glass)
    put(s, 5, 4, 4, ID.glass)
    const { translucent, liquid } = both(s)
    expect(translucent.quadCount).toBe(10)
    expect(liquid.quadCount).toBe(0)
    assertOutwardWinding(translucent.build())
  })
})

describe('Mesher', () => {
  it('fills all four layers and reuses its buffers', () => {
    const s = emptySnap()
    put(s, 1, 1, 1, ID.stone)
    put(s, 3, 1, 1, ID.torch)
    put(s, 5, 1, 1, water(7))
    put(s, 7, 1, 1, ID.glass)
    const mesher = new Mesher()
    const a = mesher.mesh(s, tables)
    expect(a.opaque).not.toBeNull()
    expect(a.cutout).not.toBeNull()
    expect(a.translucent).not.toBeNull()
    expect(a.liquid).not.toBeNull()
    const b = mesher.mesh(emptySnap(), tables)
    expect(b).toEqual({ opaque: null, cutout: null, translucent: null, liquid: null, grass: null, flowers: null })
  })
  it('meshChunk matches Mesher output', () => {
    const s = emptySnap()
    put(s, 1, 1, 1, ID.stone)
    put(s, 2, 1, 1, ID.stone)
    put(s, 5, 1, 1, water(7))
    expect(meshChunk(s, tables)).toEqual(new Mesher().mesh(s, tables))
  })
})

describe('liquid groups, springs and flow', () => {
  const reg = new BlockRegistry([...TEST_BLOCKS, defineBlock({ name: 'spring', liquid: true, source: 'water', textures: 'water' })])
  const SPRING_ID = 8
  const t2 = meshTablesFrom(reg, reg.faceLayers(new Map(reg.textureNames().map((n, i) => [n, i + 1]))))
  const liquidOf = (s: ChunkSnapshot) => { const t = new QuadBuilder(), l = new QuadBuilder(); meshTranslucent(s, t2, t, l); return l.build() }
  const faces = (m: ReturnType<typeof liquidOf>, normal: number) => {
    const out: { a: number; b: number }[] = []
    if (m) for (let i = 0; i < m.vertices.length; i += 8) if (unpackA(m.vertices[i]!).normal === normal) out.push({ a: m.vertices[i]!, b: m.vertices[i + 1]! })
    return out
  }

  it('draws no face between water and its spring', () => {
    const s = emptySnap()
    put(s, 5, 5, 5, water(0))
    put(s, 6, 5, 5, packVoxel(SPRING_ID, 3))
    const m = liquidOf(s)
    expect(faces(m, FACE.PX).length + faces(m, FACE.NX).length).toBe(2) // only the outer -x of the water and +x of the spring
  })
  it('draws a spring at full level whatever its state', () => {
    const s = emptySnap()
    put(s, 6, 5, 5, packVoxel(SPRING_ID, 3))
    const tops = faces(liquidOf(s), FACE.PY)
    expect(tops).toHaveLength(1)
    expect(unpackA(tops[0]!.a).drop).toBe(Math.round((1 - liquidHeight(7)) * 16))
  })
  it('points the top-face flow downhill and leaves flat water still', () => {
    const s = emptySnap()
    for (let x = 4; x <= 6; x++) put(s, x, 5, 5, water(x === 4 ? 7 : x === 5 ? 3 : 0))
    const tops = faces(liquidOf(s), FACE.PY)
    const mid = tops.find((f) => unpackA(f.a).x === 5)! // the first vertex of the x = 5 cell's top quad
    const code = unpackFlow(mid.a, mid.b)
    expect(code & FLOW.MOVING).toBeTruthy()
    expect(code & 7).toBe(0) // toward +x
    const flat = emptySnap()
    for (let x = 4; x <= 6; x++) put(flat, x, 5, 5, water(5))
    for (const f of faces(liquidOf(flat), FACE.PY)) expect(unpackFlow(f.a, f.b)).toBe(FLOW.STILL)
  })
  it('marks the sides of falling water steep and leaves the top cell still', () => {
    const s = emptySnap()
    put(s, 5, 5, 5, water(7))
    put(s, 5, 6, 5, water(7))
    const side = faces(liquidOf(s), FACE.PX) // first vertex of each quad sits at the cell's own y
    const lower = side.filter((f) => unpackA(f.a).y === 5)
    const upper = side.filter((f) => unpackA(f.a).y === 6)
    expect([lower.length, upper.length]).toEqual([1, 1])
    expect(unpackFlow(lower[0]!.a, lower[0]!.b) & FLOW.STEEP).toBeTruthy()
    expect(unpackFlow(upper[0]!.a, upper[0]!.b)).toBe(FLOW.STILL)
  })
  it('refuses a liquid texture layer at or above 512', () => {
    const fl = reg.faceLayers(new Map(reg.textureNames().map((n) => [n, n === 'water' ? 600 : 1])))
    expect(() => meshTablesFrom(reg, fl)).toThrow(/below layer 512/)
  })
})
