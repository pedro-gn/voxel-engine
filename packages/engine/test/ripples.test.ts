import { describe, expect, it } from 'vitest'
import { RIPPLE_CAPACITY, RIPPLE_LIFE, RippleSet, atWaterLine } from '../src/render/water/ripples.ts'
import { SurfaceView } from '../src/render/water/surfaceView.ts'
import { WaterColumns } from '../src/sim/water/columns.ts'
import { SUB } from '../src/sim/water/constants.ts'
import { WaterPublisher } from '../src/sim/water/publish.ts'
import { createWaterBuffers } from '../src/world/waterBuffers.ts'

/** A 32 × 32 world: a lake (floor 2, a block deep: surface at y = 3) for x < 20, dry ground (floor 2) beyond. */
function lake(): SurfaceView {
  const b = createWaterBuffers([32, 32, 32])
  const cols = new WaterColumns(32, 32, new Int16Array(b.floor))
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) { cols.floor[x + z * 32] = 2; cols.depth[x + z * 32] = x < 20 ? SUB : 0 }
  const view = new SurfaceView([32, 32, 32], b, () => 15)
  view.apply(new WaterPublisher(b).publish([0, 1, 2, 3], cols)!)
  return view
}

describe('atWaterLine', () => {
  const view = lake()
  it('counts a block in or on the water, and one a block above or below its surface', () => {
    expect(atWaterLine(view, 10, 3, 10)).toBe(true) // resting on the surface (the block spans 3..4, the surface is at 3)
    expect(atWaterLine(view, 10, 2, 10)).toBe(true) // just under the surface (2..3)
    expect(atWaterLine(view, 10, 4, 10)).toBe(true) // its bottom a block above the surface
    expect(atWaterLine(view, 10, 5, 10)).toBe(false) // two blocks above
    expect(atWaterLine(view, 10, 1, 10)).toBe(true) // its top a block under the surface
  })

  it('leaves out a block a few blocks above the lake, or far under it', () => {
    expect(atWaterLine(view, 10, 6, 10)).toBe(false) // 3 above
    expect(atWaterLine(view, 10, 12, 10)).toBe(false) // a deck well above the lake
    expect(atWaterLine(view, 10, 0, 10)).toBe(false) // 2 under: its top is 2 below the surface
  })

  it('counts a shore block beside the water, and leaves out dry land', () => {
    expect(atWaterLine(view, 20, 3, 10)).toBe(true) // dry column, its west neighbour is wet
    expect(atWaterLine(view, 21, 3, 10)).toBe(false) // two columns inland: no wet neighbour
    expect(atWaterLine(view, 25, 2, 25)).toBe(false) // dry land
    expect(atWaterLine(view, 20, 8, 10)).toBe(false) // a shore column, but high above the water
  })

  it('ignores a position outside the world', () => {
    expect(atWaterLine(view, -5, 3, 10)).toBe(false)
    expect(atWaterLine(view, 10, 3, 40)).toBe(false)
  })
})

describe('RippleSet', () => {
  it('starts a ripple at the centre of the block, and ages them with the frame clock until they die', () => {
    const r = new RippleSet()
    expect(r.count).toBe(0)
    r.add(10.5, 20.5)
    expect([r.count, r.x[0], r.z[0], r.start[0]]).toEqual([1, 10.5, 20.5, 0])
    r.update(0.5)
    r.add(3.5, 4.5)
    expect([r.count, r.start[1]]).toEqual([2, 0.5])
    r.update(RIPPLE_LIFE - 0.4) // the first is 1.3 s old: gone
    expect(r.count).toBe(1)
    expect([r.x[0], r.z[0]]).toEqual([3.5, 4.5])
    r.update(RIPPLE_LIFE)
    expect(r.count).toBe(0)
  })

  it('keeps a fixed pool: edits in quick succession each get a ripple, and the oldest is replaced beyond it', () => {
    const r = new RippleSet()
    for (let i = 0; i < RIPPLE_CAPACITY; i++) { r.add(i, 0); r.update(0.01) }
    expect(r.count).toBe(RIPPLE_CAPACITY)
    r.add(100, 0) // the pool is full: the one at x = 0 goes
    expect(r.count).toBe(RIPPLE_CAPACITY)
    const xs = Array.from({ length: r.count }, (_, i) => r.x[i]!).sort((a, b) => a - b)
    expect(xs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 100])
  })
})
