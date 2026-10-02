import { describe, expect, it } from 'vitest'
import { MAX_BLADES } from '../src/render/decorations/defs.ts'
import { flowerArrays, tuftArrays } from '../src/render/decorations/shapes.ts'

describe('tuftArrays', () => {
  const t = tuftArrays()
  it('builds MAX_BLADES blades of 5 vertices and 3 triangles', () => {
    expect(t.position.length).toBe(MAX_BLADES * 5 * 3)
    expect(t.info.length).toBe(MAX_BLADES * 5 * 4)
    expect(t.index.length).toBe(MAX_BLADES * 9)
    expect(Math.max(...t.index)).toBe(MAX_BLADES * 5 - 1)
  })
  it('roots every blade inside the cell and spans height 0–1', () => {
    for (let v = 0; v < MAX_BLADES * 5; v++) {
      const y = t.position[v * 3 + 1]!
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(1)
      const [b, j, rx, rz] = [t.info[v * 4]!, t.info[v * 4 + 1]!, t.info[v * 4 + 2]!, t.info[v * 4 + 3]!]
      expect(Number.isInteger(b) && b >= 0 && b < MAX_BLADES).toBe(true)
      expect(j).toBeGreaterThanOrEqual(0)
      expect(j).toBeLessThan(1)
      for (const r of [rx, rz]) { expect(r).toBeGreaterThanOrEqual(0.08); expect(r).toBeLessThanOrEqual(0.92) }
    }
  })
  it('is deterministic', () => expect(tuftArrays()).toEqual(t))
})

describe('flowerArrays', () => {
  it('builds a stem and two crossed petal quads', () => {
    const f = flowerArrays()
    expect(f.position.length).toBe(12 * 3)
    expect(f.index.length).toBe(18)
    const parts = new Set<number>()
    for (let v = 0; v < 12; v++) parts.add(f.info[v * 4]!)
    expect([...parts].sort()).toEqual([0, 1])
  })
})
