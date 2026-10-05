import { describe, expect, it } from 'vitest'
import { RIPPLE_CAPACITY, RIPPLE_LIFE, RippleSet, atWaterLine, editRipples, rippleHeightWeight, waterLineSurface } from '../src/render/water/ripples.ts'
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
    r.add(10.5, 20.5, 3)
    expect([r.count, r.x[0], r.z[0], r.start[0]]).toEqual([1, 10.5, 20.5, 0])
    r.update(0.5)
    r.add(3.5, 4.5, 3)
    expect([r.count, r.start[1]]).toEqual([2, 0.5])
    r.update(RIPPLE_LIFE - 0.4) // the first is 1.3 s old: gone
    expect(r.count).toBe(1)
    expect([r.x[0], r.z[0]]).toEqual([3.5, 4.5])
    r.update(RIPPLE_LIFE)
    expect(r.count).toBe(0)
  })

  it('keeps a fixed pool: edits in quick succession each get a ripple, and the oldest is replaced beyond it', () => {
    const r = new RippleSet()
    for (let i = 0; i < RIPPLE_CAPACITY; i++) { r.add(i, 0, 3); r.update(0.01) }
    expect(r.count).toBe(RIPPLE_CAPACITY)
    r.add(100, 0, 3) // the pool is full: the one at x = 0 goes
    expect(r.count).toBe(RIPPLE_CAPACITY)
    const xs = Array.from({ length: r.count }, (_, i) => r.x[i]!).sort((a, b) => a - b)
    expect(xs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 100])
  })
})

/** A lake at y 3 (x < 20) and a raised pool at y 12 (x >= 24, z < 8) above it, in one world. */
function twoLevels(): SurfaceView {
  const b = createWaterBuffers([32, 32, 32])
  const cols = new WaterColumns(32, 32, new Int16Array(b.floor))
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
    const pool = x >= 24 && z < 8
    cols.floor[x + z * 32] = pool ? 11 : 2
    cols.depth[x + z * 32] = pool ? SUB : x < 20 ? SUB : 0
  }
  const view = new SurfaceView([32, 32, 32], b, () => 15)
  view.apply(new WaterPublisher(b).publish([0, 1, 2, 3], cols)!)
  return view
}

describe('ripples, review round 1', () => {
  it('rings only the water at the level of the edit: a lower pool within the radius gets none (1)', () => {
    const view = twoLevels()
    expect(waterLineSurface(view, 23, 12, 4)).toBe(12) // beside the raised pool
    const set = new RippleSet()
    set.add(23.5, 4.5, waterLineSurface(view, 23, 12, 4)!)
    expect(set.weightAt(0, 12)).toBe(1) // the pool's own surface
    expect(set.weightAt(0, 12.3)).toBeGreaterThan(0)
    expect(set.weightAt(0, 3)).toBe(0) // the lake nine blocks below
    expect(rippleHeightWeight(0.5)).toBe(0)
  })

  it('ripples a region edit at the water-line cells of its shell, spaced and capped, and skips no-op edits (2, 3)', () => {
    const view = lake()
    const set = new RippleSet()
    const air = () => 0
    // A 12-wide fill along the water line (y 2..4) of the lake: at most 4 ripples, at least 3 blocks apart.
    editRipples(view, set, { type: 'fillRegion', min: [2, 2, 2], max: [13, 4, 13], voxel: 5 }, air)
    expect(set.count).toBeGreaterThan(1)
    expect(set.count).toBeLessThanOrEqual(4)
    for (let i = 0; i < set.count; i++) for (let j = i + 1; j < set.count; j++) {
      expect(Math.hypot(set.x[i]! - set.x[j]!, set.z[i]! - set.z[j]!)).toBeGreaterThanOrEqual(3)
    }
    // A region high above the lake: nothing. A block already there: nothing.
    const quiet = new RippleSet()
    editRipples(view, quiet, { type: 'fillRegion', min: [2, 20, 2], max: [13, 22, 13], voxel: 5 }, air)
    editRipples(view, quiet, { type: 'setBlock', pos: [10, 3, 10], voxel: 5 }, () => 5)
    editRipples(view, quiet, { type: 'fillRegion', min: [2, 2, 2], max: [13, 4, 13], voxel: 5 }, () => 5)
    expect(quiet.count).toBe(0)
    editRipples(view, quiet, { type: 'setBlock', pos: [10, 3, 10], voxel: 5 }, air)
    expect(quiet.count).toBe(1)
  })

  it('rings a breach and a dig on the dry shore beside the water, with the same neighbour rule as one block (A)', () => {
    const view = lake() // wet for x < 20, dry from x = 20
    const air = () => 0
    const breach = new RippleSet()
    editRipples(view, breach, { type: 'fillRegion', min: [20, 2, 10], max: [20, 4, 19], voxel: 0 }, () => 5) // a 1-wide cut on the shore column
    expect(breach.count).toBeGreaterThan(0)
    const dig = new RippleSet()
    editRipples(view, dig, { type: 'fillRegion', min: [20, 2, 10], max: [25, 4, 13], voxel: 0 }, () => 5) // dry ground opening into the lake
    expect(dig.count).toBeGreaterThan(0)
    for (let i = 0; i < dig.count; i++) expect(dig.x[i]).toBeLessThan(21) // only where a wet neighbour is
    const inland = new RippleSet()
    editRipples(view, inland, { type: 'fillRegion', min: [24, 2, 10], max: [28, 4, 13], voxel: 5 }, air) // dry land, no water beside
    expect(inland.count).toBe(0)
  })

  it('spreads the ripples of a region around its shell instead of along its first row (B)', () => {
    const view = lake()
    const set = new RippleSet()
    editRipples(view, set, { type: 'fillRegion', min: [2, 2, 2], max: [13, 4, 13], voxel: 5 }, () => 0)
    expect(set.count).toBe(4)
    const xs = new Set(Array.from({ length: 4 }, (_, i) => set.x[i]!)), zs = new Set(Array.from({ length: 4 }, (_, i) => set.z[i]!))
    expect(xs.size).toBeGreaterThan(1) // not all on one column of the region
    expect(zs.size).toBeGreaterThan(1) // not all on one row
  })

  it('restarts its clock when the pool empties, so it never drifts in a long session (4)', () => {
    const r = new RippleSet()
    r.update(5000)
    expect(r.now).toBe(0) // nothing alive: back to 0
    r.add(1, 1, 3)
    r.update(0.5)
    expect(r.now).toBe(0.5) // alive: the clock keeps running
    r.update(2)
    expect(r.now).toBe(0)
  })
})
