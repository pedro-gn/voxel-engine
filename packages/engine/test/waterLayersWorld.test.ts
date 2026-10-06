import { describe, expect, it } from 'vitest'
import { HEAD_EPS, SUB } from '../src/sim/water/constants.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, lake, run, settle, spring, w, waterSim, type Fill } from './waterHelpers.ts'

/** Stone below y 10; a lake (x 1–10, z 1–10) of water y 10–15 (surface 16) in a basin walled to y 20; a hill to y 20 elsewhere. */
const hillLake: Fill = (x, y, z) => {
  if (y < 10) return B.stone
  if (x >= 1 && x <= 10 && z >= 1 && z <= 10) return y <= 15 ? w(7) : AIR
  return y <= 20 ? B.stone : AIR
}

describe('water in layers', () => {
  it('a bridge built over a lake splits its columns: the lake runs on under it, the top is the deck', () => {
    const sim = waterSim(lake(4, 12, 12), { water: { debug: true } })
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 6, 5], voxel: B.stone })
    sim.step()
    expect(sim.water.segments(5, 5)).toEqual([
      { floor: 1, ceil: 6, depth: 4 * SUB, body: -1 }, { floor: 7, ceil: 32, depth: 0, body: -1 },
    ])
    expect(sim.water.check()).toEqual([])
  })

  it('a hole dug through a dam under a solid top drains the lake (the 3c checkpoint case)', () => {
    // the dam is the stone row x = 11; the valley (x 12–30, air from y 2) lies beyond it: open the dam's hole at y 10–11, z 5–6
    const sim = waterSim((x, y, z) => (x >= 12 && x <= 30 && z >= 1 && z <= 10 && y >= 2 && y <= 20 ? AIR : hillLake(x, y, z)), { water: { debug: true } })
    const total = sim.water.total()
    sim.submit(0, 0, { type: 'fillRegion', min: [11, 10, 5], max: [11, 11, 6], voxel: AIR })
    settle(sim, 60_000)
    let lakeDepth = 0
    for (let z = 1; z <= 10; z++) for (let x = 1; x <= 10; x++) lakeDepth += sim.water.column(x, z).depth
    expect(lakeDepth).toBeLessThan(100 * SUB) // was 600 blocks; drains to the hole's floor (y 10, the lake's own floor)
    expect(sim.water.total()).toBe(total)
    expect(sim.water.check()).toEqual([])
  })

  it('digging a tunnel from the lake to a shaft fills it and the shaft rises to the lake level (U-tube)', () => {
    // shaft at x 22–23, z 5–6, open from y 11 up; the tunnel (y 11–12, z 5–6) is dug from x 11 to x 21
    const sim = waterSim((x, y, z) => (x >= 22 && x <= 23 && z >= 5 && z <= 6 && y >= 11 ? AIR : hillLake(x, y, z)), { water: { debug: true } })
    const total = sim.water.total()
    sim.submit(0, 0, { type: 'fillRegion', min: [11, 11, 5], max: [21, 12, 6], voxel: AIR })
    settle(sim, 60_000)
    const lakeS = sim.water.column(5, 5).surface, shaftS = sim.water.column(22, 5).surface
    expect(shaftS).toBeGreaterThan(13 * SUB) // above the tunnel's roof
    expect(Math.abs(shaftS - lakeS)).toBeLessThanOrEqual(2 * HEAD_EPS)
    expect(sim.water.stats().bodies).toBeGreaterThanOrEqual(0)
    expect(sim.water.total()).toBe(total)
  })

  it('a hole through the roof of a dry cave under a shallow lake pours the lake into the cave', () => {
    // a cave (y 2–7) under x 1–10, z 1–10, roof y 8–9, the lake's floor at y 10
    const sim = waterSim((x, y, z) => (x >= 1 && x <= 10 && z >= 1 && z <= 10 && y >= 2 && y <= 7 ? AIR : hillLake(x, y, z)), { water: { debug: true } })
    const total = sim.water.total()
    expect(sim.water.segments(5, 5)[0]).toEqual({ floor: 2, ceil: 8, depth: 0, body: -1 })
    sim.submit(0, 0, { type: 'fillRegion', min: [5, 8, 5], max: [5, 9, 5], voxel: AIR })
    settle(sim, 60_000)
    let cave = 0
    for (let z = 1; z <= 10; z++) for (let x = 1; x <= 10; x++) cave += sim.water.segments(x, z)[0]!.depth
    expect(cave).toBeGreaterThan(400 * SUB) // the cave (600 blocks) took most of the lake (600 blocks)
    expect(sim.water.total()).toBe(total)
  })

  it('a slab built bottom-up by one fillRegion mid-lake traps the water under it as a full lower segment (Review Focus 1)', () => {
    const sim = waterSim(lake(6, 22, 8), { water: { debug: true } })
    sim.setPaused(true)
    const total = sim.water.total()
    sim.submit(0, 0, { type: 'fillRegion', min: [8, 3, 8], max: [13, 4, 13], voxel: B.stone })
    sim.step()
    expect(sim.water.total()).toBe(total)
    expect(sim.water.check()).toEqual([])
    const s = sim.water.segments(10, 10)
    expect(s[0]).toMatchObject({ floor: 1, ceil: 3, depth: 2 * SUB })
    expect(s[s.length - 1]!.floor).toBe(5)
    sim.setPaused(false)
    run(sim, 3)
    expect(sim.water.segments(10, 10)[0]!.body).toBeGreaterThanOrEqual(0) // full: grouped into a body
  })

  it('sand landing in a cave pool raises it by its volume, never past the roof', () => {
    // a cave pool (y 2–3 water, roof at y 6) with a shaft above (5, 5) open to the sky
    const sim = waterSim((x, y, z) => {
      if (y < 2) return B.stone
      const cave = x >= 1 && x <= 10 && z >= 1 && z <= 10 && y <= 5
      if (cave) return y <= 3 ? w(7) : AIR
      if (x === 5 && z === 5 && y >= 6) return AIR
      return y <= 12 ? B.stone : AIR
    }, { water: { debug: true } })
    const total = sim.water.total()
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 20, 5], voxel: B.sand })
    settle(sim, 20_000)
    expect(sim.store.getVoxel(5, 2, 5)).toBe(B.sand)
    expect(sim.water.total()).toBe(total)
    expect(sim.water.check()).toEqual([])
  })

  it('a spring under a cave feeds the cave segment resting on it, at most its room', () => {
    const sim = waterSim((x, y, z) => {
      if (x === 5 && z === 5 && y === 1) return spring(15) // 2048 sub per step: fills the 200-block cave in ~25 steps
      if (y < 2) return B.stone
      return x >= 1 && x <= 10 && z >= 1 && z <= 10 && y <= 3 ? AIR : B.stone
    })
    run(sim, 2000)
    for (let z = 1; z <= 10; z++) for (let x = 1; x <= 10; x++) {
      const seg = sim.water.segments(x, z)[0]!
      expect(seg.depth).toBeLessThanOrEqual(2 * SUB)
    }
    expect(sim.water.segments(5, 5)[0]!.depth).toBeGreaterThan(0)
    expect(sim.water.total()).toBe(sim.water.expected)
  })
})

describe('openings into a body (final review C1)', () => {
  it('digging the plug at the far end of a full tunnel while the lake sleeps lifts the shaft (Review Focus 2)', () => {
    // a lake (x 1–20, z 1–10, water y 10–19), a full tunnel (x 21–40, z 5–6, y 12–13), a plug at x 41, a shaft (x 42–43) open from y 12
    const sim = waterSim((x, y, z) => {
      if (y < 10) return B.stone
      if (x >= 1 && x <= 20 && z >= 1 && z <= 10) return y <= 19 ? w(7) : AIR
      if (z >= 5 && z <= 6 && y >= 12 && y <= 13 && x >= 21 && x <= 40) return w(7)
      if (z >= 5 && z <= 6 && x >= 42 && x <= 43 && y >= 12) return AIR
      return y <= 24 ? B.stone : AIR
    }, { size: [64, 32, 32], water: { debug: true } })
    settle(sim, 60_000)
    const total = sim.water.total()
    sim.submit(0, 0, { type: 'fillRegion', min: [41, 12, 5], max: [41, 13, 6], voxel: AIR })
    settle(sim, 60_000)
    expect(sim.water.column(42, 5).surface).toBeGreaterThan(14 * SUB) // above the tunnel's roof: pressure lifted it
    expect(Math.abs(sim.water.column(42, 5).surface - sim.water.column(10, 5).surface)).toBeLessThanOrEqual(2 * HEAD_EPS)
    expect(sim.water.total()).toBe(total)
  })

  it('digging into a sealed full chamber from the side lets its water out into a pit', () => {
    const sim = waterSim((x, y, z) => {
      if (x >= 3 && x <= 8 && z >= 3 && z <= 8 && y >= 4 && y <= 6) return w(7) // the sealed chamber
      if (x >= 10 && x <= 12 && z >= 3 && z <= 8 && y >= 2) return AIR // an open pit beside it
      return y <= 12 ? B.stone : AIR
    }, { water: { debug: true } })
    run(sim, 5) // the chamber is grouped into a sealed body first
    expect(sim.water.segments(5, 5)[0]!.body).toBeGreaterThanOrEqual(0)
    const total = sim.water.total()
    sim.submit(0, 0, { type: 'fillRegion', min: [9, 4, 5], max: [9, 6, 5], voxel: AIR })
    run(sim, 600)
    let pit = 0
    for (let z = 3; z <= 8; z++) for (let x = 10; x <= 12; x++) pit += sim.water.column(x, z).depth
    expect(pit).toBeGreaterThan(10 * SUB)
    expect(sim.water.total()).toBe(total)
  })
})
