import { describe, expect, it } from 'vitest'
import { Pcg32 } from '../src/sim/rng.ts'
import { WaterColumns, damp, moved } from '../src/sim/water/columns.ts'
import { GAIN, HEAD_EPS, MIN_FLOW, SUB, THROTTLED_GAIN } from '../src/sim/water/constants.ts'
import { quantize } from '../src/sim/water/mirror.ts'

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

/** The largest head over an edge whose higher side could send (at least MIN_FLOW deep). */
function maxHead(g: WaterColumns): number {
  let m = 0
  for (let z = 0; z < g.sz; z++) for (let x = 0; x < g.sx; x++) {
    const c = x + z * g.sx
    for (const b of [x + 1 < g.sx ? c + 1 : -1, z + 1 < g.sz ? c + g.sx : -1]) {
      if (b < 0) continue
      const h = g.surface(c) - g.surface(b)
      if ((h > 0 && g.depth[c]! >= MIN_FLOW) || (h < 0 && g.depth[b]! >= MIN_FLOW)) m = Math.max(m, Math.abs(h))
    }
  }
  return m
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

  it.each([1, 2, 3])('relaxes a slope of %i sub per column (zero start flux) before it sleeps: flat to one mirror level', (slope) => {
    // A walled 64 × 16 channel (four tiles in a row) and a 64 × 64 basin sloping along x + z.
    for (const [sx, sz, s] of [[64, 16, (x: number) => x * slope], [64, 64, (x: number, z: number) => (x + z) * slope]] as const) {
      const g = grid(sx, sz, box(sx, sz, 0), (x, z) => (x > 0 && z > 0 && x < sx - 1 && z < sz - 1 ? 2 * SUB + s(x, z) : 0))
      const v0 = g.total()
      settle(g)
      expect(g.total()).toBe(v0)
      expect(spread(g)).toBeLessThan(SUB / 8)
      expect(maxHead(g)).toBeLessThanOrEqual(HEAD_EPS)
      expect(g.flux.every((f) => f === 0)).toBe(true)
    }
  }, 60_000)

  it.each([[1, 8], [1, 4], [1, 2]])('relaxes a gentle slope of %i/%i sub per column along a 256-column channel to one mirror level', (num, den) => {
    // Gentle slopes are staircases of 1-sub heads: a tile's run ends alone would hide them.
    const sx = 256, sz = 16
    const g = grid(sx, sz, box(sx, sz, 0), (x, z) => (x > 0 && z > 0 && x < sx - 1 && z < sz - 1 ? 2 * SUB + Math.floor((x * num) / den) : 0))
    const v0 = g.total()
    settle(g, CAP, 200_000)
    expect(g.total()).toBe(v0)
    expect(spread(g)).toBeLessThanOrEqual(SUB / 8)
  }, 120_000)

  it('republishes a sleeping tile whose border flux stops moving water, though no water crossed', () => {
    // Tiles 0 and 1 side by side, level; tile 0 sleeps. The edge from column 15 into tile 1 is stored in tile 0 and moved 1.
    const g = grid(32, 16, () => 0, () => 100)
    g.tiles.clear()
    g.tiles.wake(1)
    g.flux[2 * (15 + 3 * 32)] = 16
    g.tiles.dirty.fill(0)
    g.step(CAP, null, 0)
    expect(moved(g.flux[2 * (15 + 3 * 32)]!)).toBe(0)
    expect(g.tiles.dirty[0]).toBe(1)
  })

  it('drains a sheet into a trench until no visible water stands above a neighbour, even over a film', () => {
    // 128 × 32 walled sheet on a floor at 10, 40 sub deep; a trench on the floor at 0 along x = 126.
    const sx = 128, sz = 32
    const wall = (x: number, z: number) => x === 0 || z === 0 || x === sx - 1 || z === sz - 1
    const g = grid(sx, sz, (x, z) => (wall(x, z) ? 100 : x === 126 ? 0 : 10), (x, z) => (wall(x, z) || x === 126 ? 0 : 40))
    const v0 = g.total()
    settle(g, CAP, 200_000, () => expect(g.total()).toBe(v0))
    let trench = 0
    for (let z = 1; z < sz - 1; z++) trench += g.depth[126 + z * sx]!
    expect(trench).toBeGreaterThanOrEqual(55_230) // what reached it before films were left out of the quiet test
    for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
      const c = x + z * sx
      if (g.depth[c]! < SUB / 16) continue
      for (const b of [x > 0 ? c - 1 : -1, x + 1 < sx ? c + 1 : -1, z > 0 ? c - sx : -1, z + 1 < sz ? c + sx : -1]) {
        if (b >= 0 && g.surface(c) - g.surface(b) > HEAD_EPS) throw new Error(`(${x}, ${z}) stands ${g.surface(c) - g.surface(b)} above a neighbour`)
      }
    }
  }, 60_000)

  it('lets a pond that can never be level sleep: two columns holding an odd volume swap 1/SUB forever', () => {
    // 32 × 32 on a floor at 2, with one two-column pit at 1 holding 25 + 26.
    const pit = (x: number, z: number) => z === 5 && (x === 5 || x === 6)
    const g = grid(32, 32, (x, z) => (pit(x, z) ? 1 : 2), (x, z) => (pit(x, z) ? (x === 5 ? 25 : 26) : 0))
    settle(g, CAP, 5_000)
    expect(g.depth[5 + 5 * 32]! + g.depth[6 + 5 * 32]!).toBe(51)
  })

  it('lets every puddle of a random shallow landscape sleep', () => {
    const rng = new Pcg32(1)
    const floors = Array.from({ length: 64 * 64 }, () => rng.nextInt(3))
    const depths = Array.from({ length: 64 * 64 }, () => rng.nextInt(12))
    const g = grid(64, 64, (x, z) => floors[x + z * 64]!, (x, z) => depths[x + z * 64]!)
    for (let t = 0; t < g.tiles.count; t++) g.tiles.wake(t)
    const v0 = g.total()
    settle(g, CAP, 20_000)
    expect(g.total()).toBe(v0)
  }, 60_000)

  it('drains a lake through a breach in its dam until, asleep, what is left lies flat to one mirror level', () => {
    // Lake: x 1..46 on a bed at 20, one block deep. Dam at x = 47, breached at z 12..19 down to the bed; a pit at 0 beyond.
    const sx = 64, sz = 32
    const g = grid(sx, sz, (x, z) => (z === 0 || z === sz - 1 || x === 0 || x === sx - 1 ? 100 : x < 47 ? 20 : x === 47 ? (z >= 12 && z <= 19 ? 20 : 100) : 0),
      (x, z) => (x > 0 && x < 47 && z > 0 && z < sz - 1 ? SUB : 0))
    const v0 = g.total()
    settle(g, CAP, 200_000, () => expect(g.total()).toBe(v0))
    let pit = 0
    const levels: number[] = []
    for (let z = 1; z < sz - 1; z++) for (let x = 1; x < sx - 1; x++) {
      const c = x + z * sx
      if (x > 47) pit += g.depth[c]!
      else if (x < 47 && g.depth[c]! >= SUB / 16) levels.push(quantize(g.surface(c))) // what the mirror shows
    }
    expect(pit).toBeGreaterThan(v0 / 2) // most of the lake went
    if (levels.length > 0) expect(Math.max(...levels) - Math.min(...levels)).toBeLessThanOrEqual(1)
    let lo = Infinity, hi = -Infinity
    for (let z = 1; z < sz - 1; z++) for (let x = 1; x < 47; x++) { const c = x + z * sx; if (g.depth[c]! > 0) { lo = Math.min(lo, g.surface(c)); hi = Math.max(hi, g.surface(c)) } }
    expect(hi - lo).toBeLessThan(SUB / 8)
  }, 60_000)

  it.each([['x', 64, 32], ['z', 32, 64]] as const)('is symmetric: a world and its %s-mirror stay mirror images every step, through every sleep', (axis, sx, sz) => {
    const rng = new Pcg32(11)
    const floors = Array.from({ length: sx * sz }, () => rng.nextInt(4))
    const depths = Array.from({ length: sx * sz }, () => (rng.nextInt(3) === 0 ? rng.nextInt(3 * SUB) : 0))
    const flip = (x: number, z: number): number => (axis === 'x' ? sx - 1 - x + z * sx : x + (sz - 1 - z) * sx)
    const a = grid(sx, sz, (x, z) => floors[x + z * sx]!, (x, z) => depths[x + z * sx]!)
    const b = grid(sx, sz, (x, z) => floors[flip(x, z)]!, (x, z) => depths[flip(x, z)]!)
    const T = a.tiles
    const flipTile = (t: number): number => {
      const tx = t % T.tx, tz = (t - tx) / T.tx
      return axis === 'x' ? T.tx - 1 - tx + tz * T.tx : tx + (T.tz - 1 - tz) * T.tx
    }
    let slept = 0
    for (let i = 0; i < 20_000 && T.awakeCount() > 0; i++) {
      a.step(CAP, null, 0)
      b.step(CAP, null, 0)
      for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
        if (a.depth[x + z * sx] !== b.depth[flip(x, z)]) throw new Error(`step ${i + 1}: (${x}, ${z}) holds ${a.depth[x + z * sx]}, its mirror ${b.depth[flip(x, z)]}`)
      }
      for (let t = 0; t < T.count; t++) expect(b.tiles.awake[flipTile(t)]).toBe(T.awake[t])
      slept = Math.max(slept, T.count - T.awakeCount())
    }
    expect(slept).toBeGreaterThan(0)
    expect(T.awakeCount()).toBe(0)
  }, 60_000)

  it('steps at most `cap` tiles per step, round robin, and still settles exactly', () => {
    const rng = new Pcg32(3)
    const depths = Array.from({ length: 32 * 32 }, () => rng.nextInt(2 * SUB))
    const g = grid(32, 32, box(32, 32, 0), (x, z) => (x > 0 && z > 0 && x < 31 && z < 31 ? depths[x + z * 32]! : 0))
    const v0 = g.total()
    settle(g, 1, 200_000, () => { expect(g.total()).toBe(v0); expect(minDepth(g)).toBeGreaterThanOrEqual(0) })
    expect(spread(g)).toBeLessThanOrEqual(16)
  })

  it('accelerates with THROTTLED_GAIN while the cap leaves awake tiles out of the step, and with GAIN otherwise', () => {
    // Two awake tiles side by side; a head of 10 sub across the edge (3, 4) → (4, 4) of the first one.
    const head = 10
    const at = (cap: number): number => {
      const g = grid(32, 16, box(32, 16, 0), (x, z) => (x === 0 || z === 0 || x === 31 || z === 15 ? 0 : x <= 3 ? 400 + head : 400))
      g.tiles.wake(0); g.tiles.wake(1)
      g.step(cap, null, 0)
      return g.flux[(3 + 4 * 32) * 2]!
    }
    expect(at(2)).toBe(head * GAIN) // every awake tile steps
    expect(at(1)).toBe(head * THROTTLED_GAIN) // tile 1 waits: the step is throttled
    expect(THROTTLED_GAIN).toBeLessThan(GAIN)
  })

  it.each([8, 4])('settles exactly, and every tile sleeps, with 16 awake tiles and a cap of %i', (cap) => {
    const rng = new Pcg32(5)
    const n = 64
    const g = grid(n, n, box(n, n, 0), (x, z) => (x > 0 && z > 0 && x < n - 1 && z < n - 1 ? rng.nextInt(2 * SUB) : 0))
    const v0 = g.total()
    settle(g, cap, 150_000, () => { expect(g.total()).toBe(v0) })
    expect(minDepth(g)).toBeGreaterThanOrEqual(0)
    expect(spread(g)).toBeLessThanOrEqual(16)
  }, 300_000)
})
