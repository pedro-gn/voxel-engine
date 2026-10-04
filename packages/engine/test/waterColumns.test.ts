import { describe, expect, it } from 'vitest'
import { Pcg32 } from '../src/sim/rng.ts'
import { WaterColumns, damp, moved } from '../src/sim/water/columns.ts'
import { MIN_FLOW, SUB } from '../src/sim/water/constants.ts'

const CAP = 1 << 20

/** sx × sz columns; floors in blocks, depths in 1/SUB block. Tiles holding water start awake. */
function grid(sx: number, sz: number, floor: (x: number, z: number) => number, depth: (x: number, z: number) => number = () => 0): WaterColumns {
  const g = new WaterColumns(sx, sz, new Int16Array(sx * sz))
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    const c = x + z * sx
    g.floor[c] = floor(x, z)
    g.depth[c] = depth(x, z)
    if (g.depth[c]! > 0) g.tiles.wake(g.tiles.of(x, z))
  }
  return g
}

/** Steps until no tile is awake; returns the steps taken. */
function settle(g: WaterColumns, cap = CAP, max = 50_000, each?: () => void): number {
  for (let i = 1; i <= max; i++) {
    g.step(cap, null, 0)
    each?.()
    if (g.tiles.awakeCount() === 0) return i
  }
  throw new Error(`still awake after ${max} steps: ${g.tiles.awakeCount()} tiles`)
}

/** A walled box: floor `bed` inside, floor `wall` on the rim. */
const box = (sx: number, sz: number, bed: number, wall = 100) =>
  (x: number, z: number) => (x === 0 || z === 0 || x === sx - 1 || z === sz - 1 ? wall : bed)

/** Max − min surface over the columns that hold water. */
function spread(g: WaterColumns): number {
  let lo = Infinity, hi = -Infinity
  for (let c = 0; c < g.n; c++) if (g.depth[c]! > 0) { lo = Math.min(lo, g.surface(c)); hi = Math.max(hi, g.surface(c)) }
  return hi - lo
}

function minDepth(g: WaterColumns): number {
  let m = Infinity
  for (let c = 0; c < g.n; c++) m = Math.min(m, g.depth[c]!)
  return m
}

describe('flux arithmetic', () => {
  it('rounds friction away from zero and transfers toward zero, the same in both directions', () => {
    expect([damp(1), damp(-1), damp(32), damp(-32), damp(0)]).toEqual([0, 0, 30, -30, 0])
    expect([moved(31), moved(-31), moved(15), moved(-15), moved(16)]).toEqual([1, -1, 0, 0, 1])
  })
})

describe('WaterColumns', () => {
  it('conserves water exactly and never goes negative over random floors and depths', () => {
    const rng = new Pcg32(7)
    const floors = Array.from({ length: 64 * 64 }, () => rng.nextInt(6))
    const depths = Array.from({ length: 64 * 64 }, () => rng.nextInt(3 * SUB))
    const g = grid(64, 64, (x, z) => floors[x + z * 64]!, (x, z) => depths[x + z * 64]!)
    const v0 = g.total()
    for (let i = 0; i < 3000; i++) {
      g.step(CAP, null, 0)
      expect(g.total()).toBe(v0)
      expect(minDepth(g)).toBeGreaterThanOrEqual(0)
    }
  })

  it('settles a lake flat, puts every tile to sleep and zeroes every flux', () => {
    const g = grid(32, 32, box(32, 32, 10), (x, z) => (x > 0 && z > 0 && x < 31 && z < 31 ? 2 * SUB + (x >= 8 && x < 12 && z >= 8 && z < 12 ? 8 * SUB : 0) : 0))
    const v0 = g.total()
    settle(g)
    expect(g.total()).toBe(v0)
    expect(spread(g)).toBeLessThanOrEqual(16)
    expect(g.flux.every((f) => f === 0)).toBe(true)
    expect(g.wetAwake()).toBe(0)
  })

  it('carries inertia: released into an empty channel, water overshoots its final level at the far wall, then settles', () => {
    // One tile, walled; water in x 1..7 at 2 blocks, the rest dry: the mean is 1 block.
    const g = grid(16, 16, box(16, 16, 0), (x, z) => (x >= 1 && x <= 7 && z >= 1 && z <= 14 ? 2 * SUB : 0))
    const far = 14 + 7 * 16
    let peak = 0
    for (let i = 0; i < 400; i++) { g.step(CAP, null, 0); peak = Math.max(peak, g.depth[far]!) }
    expect(peak).toBeGreaterThan(1.1 * SUB)
    settle(g)
    expect(spread(g)).toBeLessThanOrEqual(16)
    expect(Math.abs(g.depth[far]! - SUB)).toBeLessThanOrEqual(16)
  })

  it('pours off a ledge into a lower basin, exact to the unit', () => {
    const g = grid(32, 16, (x, z) => (x === 0 || z === 0 || x === 31 || z === 15 ? 100 : x <= 14 ? 20 : 5),
      (x, z) => (x >= 1 && x <= 14 && z >= 1 && z <= 14 ? 2 * SUB : 0))
    const v0 = g.total()
    settle(g, CAP, 50_000, () => expect(g.total()).toBe(v0))
    let basin = 0
    for (let z = 1; z <= 14; z++) for (let x = 15; x <= 30; x++) basin += g.depth[x + z * 32]!
    expect(basin).toBeGreaterThanOrEqual(0.95 * v0)
  })

  it('never moves water into a column whose floor is at or above the sender\'s surface', () => {
    const g = grid(16, 16, (x) => (x < 8 ? 0 : 3), (x) => (x < 8 ? 3 * SUB : 0))
    for (let i = 0; i < 500; i++) g.step(CAP, null, 0)
    for (let z = 0; z < 16; z++) for (let x = 8; x < 16; x++) expect(g.depth[x + z * 16]).toBe(0)
  })

  it('leaves a film thinner than MIN_FLOW where it is and lets its tile sleep', () => {
    const g = grid(16, 16, () => 0, (x, z) => (x === 5 && z === 5 ? MIN_FLOW - 1 : 0))
    settle(g)
    expect(g.depth[5 + 5 * 16]).toBe(MIN_FLOW - 1)
  })

  it('wakes exactly the tile of an edited column and the tiles of its neighbours', () => {
    const g = grid(32, 32, () => 0)
    const awake = () => [0, 1, 2, 3].filter((t) => g.tiles.awake[t] === 1)
    g.tiles.wakeAround(5, 5)
    expect(awake()).toEqual([0])
    g.tiles.clear()
    g.tiles.wakeAround(15, 5)
    expect(awake()).toEqual([0, 1])
    g.tiles.clear()
    g.tiles.wakeAround(15, 15)
    expect(awake()).toEqual([0, 1, 2])
  })

  it('keeps water inside the world at every edge: nothing crosses the border', () => {
    const corner = (x: number, z: number) => (x < 4 && z < 4) || (x >= 28 && z >= 28)
    const g = grid(32, 32, () => 0, (x, z) => (corner(x, z) ? 4 * SUB : 0))
    const v0 = g.total()
    for (let i = 0; i < 2000; i++) {
      g.step(CAP, null, 0)
      expect(g.total()).toBe(v0)
    }
    for (let z = 0; z < 32; z++) expect(g.flux[2 * (31 + z * 32)]).toBe(0) // +x edges of the last column
    for (let x = 0; x < 32; x++) expect(g.flux[2 * (x + 31 * 32) + 1]).toBe(0) // +z edges of the last row
  })

  it('steps at most `cap` tiles per step, round robin, and still settles exactly', () => {
    const rng = new Pcg32(3)
    const depths = Array.from({ length: 32 * 32 }, () => rng.nextInt(2 * SUB))
    const g = grid(32, 32, box(32, 32, 0), (x, z) => (x > 0 && z > 0 && x < 31 && z < 31 ? depths[x + z * 32]! : 0))
    const v0 = g.total()
    settle(g, 1, 200_000, () => expect(g.total()).toBe(v0))
    expect(spread(g)).toBeLessThanOrEqual(16)
  })
})
