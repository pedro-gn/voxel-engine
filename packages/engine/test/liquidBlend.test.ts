import { describe, expect, it } from 'vitest'
import { FACE, packA } from '../src/mesh/vertexFormat.ts'
import { BLEND_SECONDS, NEW_DROP, blendFrom, blendedDrop, isTopRow, type LiquidBlendState } from '../src/render/liquidBlend.ts'

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
    const r = blendFrom(prev, verts(packA(4, 6, 4, FACE.PY, 0, 2, 0)), now)
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

  it('stamps t0 = now on every vertex', () => {
    const next = verts(packA(1, 2, 1, FACE.PY, 0, 0, 1), packA(1, 1, 1, FACE.NY, 0, 0))
    expect([...blendFrom(null, next, 2.5).t0]).toEqual([2.5, 2.5])
  })
})
