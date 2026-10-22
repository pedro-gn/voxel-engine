import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import { SUB } from '../src/sim/water/constants.ts'
import type { WaterOptions } from '../src/sim/water/waterSystem.ts'
import type { GameSystem, SystemContext } from '../src/sim/systems.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, WATER_BLOCKS, basin, depthSum, fillGenerator, lake, run, settle, spring, w, waterSim, type Fill } from './waterHelpers.ts'

const EVERY = 8
const LOSS: Partial<WaterOptions> = { retain: 32, lossEvery: EVERY, debug: true }

/** A sim with the loss options whose log is kept: a failed debug check shows up there. */
function lossSim(fill: Fill, o: { size?: [number, number, number]; water?: Partial<WaterOptions>; systems?: GameSystem[] } = {}) {
  const logs: string[] = []
  const sim = waterSim(fill, { size: o.size, water: o.water ?? LOSS, systems: o.systems, log: (m) => logs.push(m) })
  return { sim, failures: () => logs.filter((m) => m.includes('check failed')) }
}

function wetColumns(sim: Simulation, x0: number, z0: number, x1: number, z1: number): number {
  let n = 0
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (sim.water.column(x, z).depth > 0) n++
  return n
}

/** Steps to the next loss pass (inclusive). */
function toPass(sim: Simulation): void {
  do sim.step(); while (sim.water.stepCount % EVERY !== 0)
}

/** A spring (flow 4, 96 sub a step: ~768 columns at 1 sub per 8 steps) on the floor at the centre of a 40 × 40 stone basin (x, z 1–40 inside, walls to y 6). */
const springBasin: Fill = (x, y, z) => {
  if (x === 20 && z === 20 && y === 0) return spring(4)
  return basin(42, 6)(x, y, z)
}

describe('water loss option', () => {
  it('validates lossEvery and starts with nothing lost', () => {
    expect(() => waterSim(lake(1, 8, 3), { water: { lossEvery: -1 } })).toThrow(/lossEvery/)
    expect(() => waterSim(lake(1, 8, 3), { water: { lossEvery: 1.5 } })).toThrow(/lossEvery/)
    const sim = waterSim(lake(1, 8, 3))
    expect(sim.water.o.lossEvery).toBe(0)
    expect(sim.water.lost).toBe(0)
  })

  it('a pond with no inflow sinks one sub per pass and empties', () => {
    const { sim, failures } = lossSim(lake(1, 8, 3)) // a 6 × 6 pond, x and z 1–6, 1 block deep
    const start = depthSum(sim, 1, 1, 6, 6)
    expect(start).toBe(36 * SUB)
    for (let k = 1; k <= 10; k++) {
      run(sim, EVERY)
      for (let z = 1; z <= 6; z++) for (let x = 1; x <= 6; x++) expect(Math.abs(sim.water.column(x, z).depth - (SUB - k))).toBeLessThanOrEqual(1)
    }
    run(sim, EVERY * (SUB - 10) + 4 * EVERY)
    expect(depthSum(sim, 1, 1, 6, 6)).toBe(0)
    expect(sim.water.lost).toBe(start)
    expect(sim.water.total()).toBe(start)
    expect(sim.water.check()).toEqual([])
    expect(failures()).toEqual([])
  })

  it('a spring into a closed basin stops growing', () => {
    const { sim, failures } = lossSim(springBasin, { size: [64, 32, 64], water: { retain: 32, lossEvery: EVERY } })
    run(sim, 6000)
    const a = wetColumns(sim, 1, 1, 40, 40)
    run(sim, 2000)
    const b = wetColumns(sim, 1, 1, 40, 40)
    expect(a).toBeGreaterThan(0)
    expect(b).toBeLessThan(1600)
    expect(Math.abs(b - a) / a).toBeLessThan(0.05)
    expect(sim.water.check()).toEqual([])
    expect(failures()).toEqual([])
  }, 30_000)

  it('a still film under retain vanishes within one pass', () => {
    let script: ((c: SystemContext) => void) | null = null
    const sys: GameSystem = { name: 'probe', version: 1, snapshot: () => null, tick: (c) => { const f = script; script = null; f?.(c) } }
    // a one-cell pit (5, 1, 5) holding one level of water (32 sub)
    const pit: Fill = (x, y, z) => (y === 1 && x === 5 && z === 5 ? w(0) : y <= 1 ? B.stone : AIR)
    const { sim, failures } = lossSim(pit, { systems: [sys] })
    toPass(sim)
    script = (c) => { c.takeWater(5, 1, 5, 12) }
    sim.step()
    const left = sim.water.column(5, 5).depth
    expect(left).toBeGreaterThan(0)
    expect(left).toBeLessThan(32)
    toPass(sim)
    expect(sim.water.column(5, 5).depth).toBe(0)
    run(sim, 2)
    expect(sim.store.getVoxel(5, 1, 5)).toBe(AIR)
    expect(failures()).toEqual([])
  })

  it('a spreading front survives loss passes', () => {
    const flat: Fill = (x, y, z) => (y === 0 ? (x === 32 && z === 32 ? spring(4) : B.stone) : AIR)
    const { sim, failures } = lossSim(flat, { size: [64, 32, 64] })
    run(sim, 40)
    let before = wetColumns(sim, 0, 0, 63, 63)
    for (let k = 0; k < 5; k++) {
      run(sim, 3 * EVERY)
      const now = wetColumns(sim, 0, 0, 63, 63)
      expect(now).toBeGreaterThan(before)
      before = now
    }
    expect(failures()).toEqual([])
  })

  it('a settled pond sleeps between loss passes', () => {
    const { sim, failures } = lossSim(lake(2, 12, 4)) // a walled 10 × 10 pond, 2 blocks deep
    settle(sim)
    const before = sim.water.column(5, 5).depth
    let published = 0
    for (let i = 0; i < 20 * EVERY; i++) {
      const r = sim.step()
      expect(sim.water.stats().tiles).toBe(0)
      if (r.water) published++
    }
    expect(published).toBeGreaterThan(0) // a pass republishes the lowered surface
    expect(sim.water.column(5, 5).depth).toBe(before - 20)
    expect(failures()).toEqual([])
  })

  it('a settled pond with a free shore is asleep again before every pass', () => {
    // 9 blocks³ poured on a flat 64 × 64 floor: its shore is open ground, where a pass may dry a film and wake the tile
    const poured: Fill = (x, y, z) => (y === 0 ? B.stone : y === 1 && x >= 31 && x <= 33 && z >= 31 && z <= 33 ? w(7) : AIR)
    const { sim, failures } = lossSim(poured, { size: [64, 32, 64], water: { retain: 32, lossEvery: 112, debug: true } })
    settle(sim)
    while (sim.water.stepCount % 112 !== 0) sim.step() // a pass just ran
    let awakeSteps = 0
    for (let k = 0; k < 10; k++) {
      for (let i = 0; i < 111; i++) { sim.step(); if (sim.water.stats().tiles > 0) awakeSteps++ }
      expect(sim.water.stats().tiles).toBe(0) // the step before the next pass
      sim.step()
    }
    expect(awakeSteps).toBeLessThan(10 * 111 / 4)
    expect(failures()).toEqual([])
  })

  it('a loss pass on a still lake republishes only changed tiles', () => {
    // a walled 38 × 38 lake 2 blocks deep over 9 tiles: a pass lowers every column by 1/SUB, which changes no drawn level
    // until the surface crosses a mirror eighth (about pass 17 of 20 here)
    const { sim, failures } = lossSim(lake(2, 40, 4), { size: [64, 32, 64] })
    settle(sim)
    toPass(sim)
    let publishes = 0, tiles = 0
    for (let i = 0; i < 20 * EVERY; i++) {
      const r = sim.step()
      expect(sim.water.stats().tiles).toBe(0)
      if (r.water) { publishes++; tiles += r.water.tiles.length }
    }
    expect(sim.water.column(20, 20).depth).toBeLessThan(2 * SUB - 16) // the surface did cross an eighth: some passes publish
    expect(publishes).toBeGreaterThan(0)
    expect(publishes).toBeLessThanOrEqual(8) // a crossing pass and the next step's other parity, a few times over
    expect(tiles).toBeLessThanOrEqual(8 * 9)
    expect(failures()).toEqual([])
  })

  it('rules read no water under retain', () => {
    // The reviewer's ledge (I1): a 20 × 20 basin, its west half (x 1–10) a pond on the floor (y 1 full and one level at
    // y 2), its east half a ledge (stone at y 1) holding the same level at y 2. The ledge column beside the pond keeps a
    // film the pond's water stands against: undrawn, it must read dry to game rules.
    let script: ((c: SystemContext) => void) | null = null
    const sys: GameSystem = { name: 'probe', version: 1, snapshot: () => null, tick: (c) => { const f = script; script = null; f?.(c) } }
    const b = basin(22, 6)
    const fill: Fill = (x, y, z) => {
      const v = b(x, y, z)
      if (v !== AIR || x < 1 || x > 20 || z < 1 || z > 20) return v
      if (y === 1) return x <= 10 ? w(7) : B.stone
      return y === 2 ? w(0) : AIR
    }
    const { sim, failures } = lossSim(fill, { water: { retain: 32, lossEvery: 112, debug: true }, systems: [sys] })
    const air = () => sim.store.getVoxel(11, 2, 10) === AIR
    let passes = 0
    while (!(air() && sim.water.column(11, 10).depth > 0) && passes < 40) {
      run(sim, 112)
      passes++
    }
    expect(air()).toBe(true)
    expect(sim.water.column(11, 10).depth).toBeGreaterThan(0)
    let got: number[] = []
    const before = sim.water.total()
    script = (c) => { got = [c.waterDepth(11, 2, 10), c.takeWater(11, 2, 10, 64), c.waterDepth(10, 2, 10)] }
    sim.step()
    expect(got[0]).toBe(0)
    expect(got[1]).toBe(0)
    expect(got[2]).toBeGreaterThan(0) // the pond beside it still serves the rules
    expect(sim.water.total()).toBe(before)
    expect(failures()).toEqual([])
  })

  it('free underground water drains; a full body does not lose', () => {
    // Two sealed stone rooms under a roof at y 4: a half-filled tunnel (x 2–9, cells y 1–3, water at y 1) and a full
    // chamber (x 12–19, cells y 1–3, all water).
    const fill: Fill = (x, y, z) => {
      if (y === 0 || y >= 4 && y <= 5) return B.stone
      if (y > 5) return AIR
      if (z !== 5) return B.stone
      if (x >= 2 && x <= 9) return y === 1 ? w(7) : AIR
      if (x >= 12 && x <= 19) return w(7)
      return B.stone
    }
    const { sim, failures } = lossSim(fill)
    const tunnel = () => { let s = 0; for (let x = 2; x <= 9; x++) for (const g of sim.water.segments(x, 5)) if (g.ceil <= 4) s += g.depth; return s }
    const chamber = () => { let s = 0; for (let x = 12; x <= 19; x++) for (const g of sim.water.segments(x, 5)) if (g.ceil <= 4) s += g.depth; return s }
    expect(tunnel()).toBe(8 * SUB)
    expect(chamber()).toBe(8 * 3 * SUB)
    run(sim, 10 * EVERY)
    expect(tunnel()).toBe(8 * SUB - 8 * 10)
    expect(chamber()).toBe(8 * 3 * SUB)
    expect(sim.water.check()).toEqual([])
    expect(failures()).toEqual([])
  })

  it('snapshot mid-loss resumes identically', () => {
    const size: [number, number, number] = [64, 32, 64]
    const make = () => new Simulation({ buffers: createWorldBuffers(size), blocks: WATER_BLOCKS, seed: 1, randomTicksPerChunk: 0, log: () => {}, water: LOSS })
    const a = make()
    const gen = fillGenerator(springBasin)
    a.configure(gen, null)
    a.generate(gen)
    run(a, 1003)
    expect(a.water.lost).toBeGreaterThan(0)
    const snap = a.snapshot(null)
    const restore = () => {
      const s = make()
      s.configure(fillGenerator(springBasin), null)
      s.restore({ tick: snap.tick, paused: snap.paused, regions: snap.regions, sections: Object.fromEntries(snap.sections.map((x) => [x.name, x.bytes])) })
      return s
    }
    const b = restore(), c = restore()
    expect(b.water.lost).toBe(a.water.lost)
    expect(b.water.check()).toEqual([])
    run(a, 1000)
    run(b, 1000)
    run(c, 1000)
    expect(c.hash()).toBe(b.hash())
    expect([...b.water.cols.state().depth]).toEqual([...a.water.cols.state().depth])
    expect(b.water.lost).toBe(a.water.lost)
  })

  it('lossEvery 0 is today\'s water', () => {
    for (const water of [{}, { retain: 32 }]) {
      const a = waterSim(springBasin, { size: [64, 32, 64], water }), b = waterSim(springBasin, { size: [64, 32, 64], water: { ...water, lossEvery: 0 } })
      run(a, 300)
      run(b, 300)
      expect(b.hash()).toBe(a.hash())
    }
  })
})
