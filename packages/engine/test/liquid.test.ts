import { describe, expect, it } from 'vitest'
import { isTopRow, liquidHeight, meshTranslucent } from '../src/mesh/liquid.ts'
import { Mesher, meshChunk } from '../src/mesh/mesher.ts'
import { QuadBuilder } from '../src/mesh/quadBuilder.ts'
import { BlockRegistry, defineBlock } from '../src/blocks/registry.ts'
import { meshTablesFrom } from '../src/mesh/tables.ts'
import { FACE, LIQUID_DEEP, packA, unpackA } from '../src/mesh/vertexFormat.ts'
import { OUTSIDE, PAD, type ChunkSnapshot } from '../src/world/reader.ts'
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

/** Top-face drops grouped by vertex x, for top vertices on plane y. */
function dropsByX(s: ChunkSnapshot, y: number): Map<number, Set<number>> {
  const { m } = mesh(s)
  const out = new Map<number, Set<number>>()
  for (let i = 0; i < m!.vertices.length; i += 2) {
    const a = unpackA(m!.vertices[i]!)
    if (a.normal !== FACE.PY || a.y !== y) continue
    if (!out.has(a.x)) out.set(a.x, new Set())
    out.get(a.x)!.add(a.drop)
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
    expect(topDrops(s)).toEqual([12, 12, 12, 12]) // corners average the cell (8/9) with 3 air cells (0): 2/9, so round(7/9 * 16) = 12
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
    expect(topDrops(s)).toContain(11) // shared corner: (8/9 + 4/9 + 0 + 0) / 4 = 1/3, so drop round(32/3) = 11
  })
  it('tapers edge corners to air and keeps shared corners at the average of both cells', () => {
    const s = emptySnap()
    put(s, 4, 3, 4, ID.stone); put(s, 5, 3, 4, ID.stone)
    put(s, 4, 4, 4, water(7))
    put(s, 5, 4, 4, water(7))
    const byX = dropsByX(s, 5)
    expect([...byX.get(4)!]).toEqual([12]) // (8/9 + 3 air) / 4 = 2/9
    expect([...byX.get(5)!]).toEqual([9]) // (8/9 + 8/9 + 2 air) / 4 = 4/9, so round(5/9 * 16) = 9
    expect([...byX.get(6)!]).toEqual([12])
  })
  it('keeps the edge flat against a wall: stone is excluded, not counted as air', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, water(7))
    put(s, 5, 4, 4, ID.stone)
    const byX = dropsByX(s, 5)
    expect([...byX.get(4)!]).toEqual([12]) // (8/9 + 3 air) / 4
    expect([...byX.get(5)!]).toEqual([11]) // (8/9 + 2 air) / 3 = 8/27, so round(19/27 * 16) = 11; the stone is left out
  })
  it('still forces a corner to full height next to water with water above, even with air around', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, water(7))
    put(s, 4, 5, 4, water(7)) // A has water above: height 1
    put(s, 5, 4, 4, water(7)) // B beside it, open above
    const byX = dropsByX(s, 5) // B's top plane; A's top is hidden by the water above it
    expect([...byX.get(5)!]).toEqual([0]) // touching A
    expect([...byX.get(6)!]).toEqual([12]) // air side
  })
  it('flags the top-row vertices of water over water as deep (ao bits), and nothing else', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, water(7))
    put(s, 4, 5, 4, water(0)) // a thin surface layer over deep water
    put(s, 8, 3, 8, ID.stone)
    put(s, 8, 4, 8, water(0)) // a film on a stone floor
    const { m } = mesh(s)
    const seen = { deepTop: 0, other: 0 }
    for (let i = 0; i < m!.vertices.length; i += 2) {
      const a = unpackA(m!.vertices[i]!)
      const cellY = a.normal === FACE.PY ? a.y - 1 : a.normal === FACE.NY ? a.y : a.corner >= 2 ? a.y - 1 : a.y
      if (a.x >= 4 && a.x <= 5 && cellY === 5 && isTopRow(m!.vertices[i]!)) {
        expect(a.ao, `deep top vertex ${JSON.stringify(a)}`).toBe(LIQUID_DEEP)
        seen.deepTop++
      } else {
        expect(a.ao, `vertex ${JSON.stringify(a)}`).toBe(0)
        seen.other++
      }
    }
    expect(seen.deepTop).toBe(4 + 4 * 2) // the top face and the two top corners of each of 4 sides
    expect(seen.other).toBeGreaterThan(0)
  })
  it('treats out-of-world padding as a wall: a sea at the world border keeps a full rim', () => {
    const s = emptySnap()
    for (let z = -1; z <= 32; z++) for (let x = 0; x < 4; x++) put(s, x, 4, z, water(7)) // x = -1 stays air (padding)
    s.outside = OUTSIDE.NX // the chunk sits at the world's -x border
    expect([...dropsByX(s, 5).get(0)!]).toEqual([2]) // (8/9 + 8/9) / 2: the padding is left out, like a wall
    s.outside = 0
    expect([...dropsByX(s, 5).get(0)!]).toEqual([9]) // in-world air at x = -1 tapers it: (8/9 + 8/9 + 0 + 0) / 4
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

describe('liquid groups and springs', () => {
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
    expect(unpackA(tops[0]!.a).drop).toBe(Math.round((1 - liquidHeight(7) / 4) * 16)) // full level 8/9 averaged with 3 air cells
  })
})

describe('static and simulated water', () => {
  it('never meshes the simulated water of a column the sim owns, at any height; still meshes it where no sim owns it (NO_FLOOR)', () => {
    expect(tables.waterGroup).toBe(ID.water)
    const s = emptySnap()
    put(s, 4, 3, 4, water(7)) // below the floor: a lower segment's water, simulated since 3d
    put(s, 4, 6, 4, water(7)) // at the floor: the top segment's
    put(s, 9, 6, 9, water(7)) // a column with no floor (NO_FLOOR): no sim owns it
    s.floor[(4 + 1) + (4 + 1) * PAD] = 5
    expect(mesh(s).n).toBe(6) // only the lone cell of the column nobody simulates
  })
  it('still meshes a spring above its column\'s floor', () => {
    const reg = new BlockRegistry([...TEST_BLOCKS, defineBlock({ name: 'spring', liquid: true, source: 'water', textures: 'water' })])
    const t2 = meshTablesFrom(reg, reg.faceLayers(new Map(reg.textureNames().map((n, i) => [n, i + 1]))))
    const s = emptySnap()
    put(s, 6, 5, 5, packVoxel(8, 3))
    s.floor[(6 + 1) + (5 + 1) * PAD] = 0
    const t = new QuadBuilder(), l = new QuadBuilder()
    meshTranslucent(s, t2, t, l)
    expect(l.quadCount).toBe(6)
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
