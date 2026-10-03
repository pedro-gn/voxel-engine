import { describe, expect, it } from 'vitest'
import { BrushCursor } from '../src/ui/brushes/cursor.ts'
import { LIFT } from '../src/ui/handles/overlay.ts'

describe('BrushCursor', () => {
  it('drapes a closed circle on the ground, plus an inner ring inside it', () => {
    const c = new BrushCursor(() => 30)
    c.circle(100, 100, 8, 4)
    expect(c.lines).toHaveLength(2)
    const [ring] = c.lines
    expect(ring).toHaveLength(65) // the last point repeats the first: WebGPU has no LineLoop
    for (const p of ring!) {
      expect(p.y).toBe(30 + LIFT)
      expect(Math.hypot(p.x - 100, p.z - 100)).toBeCloseTo(8)
    }
    c.circle(100, 100, 8, 8)
    expect(c.lines).toHaveLength(1)
    c.circle(100, 100, 8, null)
    expect(c.lines).toHaveLength(1)
  })

  it('outlines the biome cells whose centres lie within the radius', () => {
    const c = new BrushCursor(() => 30)
    c.cells(130, 130, 4, 4) // cells (31..33, 32), (32, 31), (32, 33)
    expect(c.lines).toHaveLength(1)
    expect(c.lines[0]).toHaveLength(5 * 8)
  })

  it('draws a sphere as three great circles', () => {
    const c = new BrushCursor(() => 0)
    c.sphere(10, 20, 30, 5, false)
    expect(c.lines).toHaveLength(3)
    for (const line of c.lines) for (const p of line) expect(Math.hypot(p.x - 10, p.y - 20, p.z - 30)).toBeCloseTo(5)
  })

  it('hides', () => {
    const c = new BrushCursor(() => 0)
    c.sphere(0, 0, 0, 5, true)
    c.hide()
    expect(c.lines).toEqual([])
    expect(c.group.children).toHaveLength(0)
  })
})
