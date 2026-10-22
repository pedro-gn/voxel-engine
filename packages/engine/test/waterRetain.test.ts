import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import { WaterColumns } from '../src/sim/water/columns.ts'
import { SUB } from '../src/sim/water/constants.ts'
import { WaterPublisher } from '../src/sim/water/publish.ts'
import type { GameSystem, SystemContext } from '../src/sim/systems.ts'
import { shows } from '../src/render/water/surfaceMesh.ts'
import { createWaterBuffers } from '../src/world/waterBuffers.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, basin, run, settle, spring, w, waterSim, type Fill } from './waterHelpers.ts'

const RETAIN = 32
/**
 * The flicker test's bound on y 1 air ↔ water changes over 10 loss passes. Measured before the fix: 65 661 (~880 cells,
 * most 4 times or more); after it: 2 at step 20 000 and 30 000, 38 at 10 000, each a cell joining a shore that still
 * creeps out, none twice. 64 leaves room for that creep (a few percent of the ~250-cell shore) and none for blinking.
 */
const TOGGLES = 64

/** A 64 × 64 stone floor (y 0) with 9 blocks³ of water standing on it at the centre (3 × 3 columns, y 1). */
const poured: Fill = (x, y, z) => (y === 0 ? B.stone : y === 1 && x >= 31 && x <= 33 && z >= 31 && z <= 33 ? w(7) : AIR)

/** The channel's floor top at x (1–64): falls one block every 8 columns, from y 9 to y 2. */
const floorTop = (x: number) => 9 - Math.floor((x - 1) / 8)
/**
 * A 1-wide channel along z 5, x 1–64, carved in stone (y ≤ 12), falling one block every 8 columns, with a spring (flow 4)
 * as the floor of its first column. Past x 64 the ground drops to a sea (floor y 0, sea level 2) that reaches the world's
 * edge, so the channel's water leaves the world and the sea pays the spring.
 */
const channel: Fill = (x, y, z) => {
  if (x <= 64) {
    if (z === 5 && x >= 1) {
      if (y < floorTop(x)) return B.stone
      if (y === floorTop(x)) return x === 1 ? spring(4) : B.stone
      return AIR
    }
    return y <= 12 ? B.stone : AIR
  }
  return y === 0 ? B.stone : y === 1 ? w(7) : AIR
}

/** A one-cell pit (5, 1, 5) in a stone floor, holding one level of water (32 sub). */
const pit: Fill = (x, y, z) => (y === 1 && x === 5 && z === 5 ? w(0) : y <= 1 ? B.stone : AIR)

function wetColumns(sim: Simulation, sx: number, sz: number): number {
  let n = 0
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) if (sim.water.column(x, z).depth > 0) n++
  return n
}

describe('water retain option', () => {
  it('validates retain', () => {
    expect(() => waterSim(pit, { water: { retain: 3 } })).toThrow(/retain/)
    expect(() => waterSim(pit, { water: { retain: SUB + 1 } })).toThrow(/retain/)
    expect(() => waterSim(pit, { water: { retain: 4.5 } })).toThrow(/retain/)
    expect(waterSim(pit, { water: { retain: SUB } }).water.o.retain).toBe(SUB)
  })

  it('water poured on a flat floor stops spreading at retain', () => {
    const today = waterSim(poured, { size: [64, 32, 64] })
    settle(today)
    const sim = waterSim(poured, { size: [64, 32, 64], water: { retain: RETAIN } })
    settle(sim)
    const wet = wetColumns(sim, 64, 64)
    expect(wet).toBeLessThan(wetColumns(today, 64, 64))
    expect(wet).toBeLessThanOrEqual((9 * SUB) / RETAIN + 64) // fronts at least retain deep, plus their thin edge
    expect(sim.water.total()).toBe(9 * SUB)
    // every column the mirror draws holds at least retain
    for (let z = 0; z < 64; z++) for (let x = 0; x < 64; x++) {
      if ((sim.store.getVoxel(x, 1, z) & 0xfff) === B.water) expect(sim.water.column(x, z).depth).toBeGreaterThanOrEqual(RETAIN)
    }
  })

  it('nothing under retain is drawn', () => {
    let script: ((c: SystemContext) => void) | null = null
    const sys: GameSystem = { name: 'probe', version: 1, snapshot: () => null, tick: (c) => { const f = script; script = null; f?.(c) } }
    const at = (retain?: number) => {
      const sim = waterSim(pit, { water: retain === undefined ? {} : { retain }, systems: [sys] })
      settle(sim)
      script = (c) => { c.takeWater(5, 1, 5, 12) }
      sim.step()
      run(sim, 2)
      expect(sim.water.column(5, 5).depth).toBe(20)
      return sim.store.getVoxel(5, 1, 5)
    }
    expect(at() & 0xfff).toBe(B.water) // today 20 sub draws one level
    expect(at(RETAIN)).toBe(AIR)
    // the publisher reports it undrawn
    const b = createWaterBuffers([32, 32, 32])
    const cols = new WaterColumns(32, 32, new Int16Array(b.floor))
    cols.floor.fill(2)
    const surface = new Int32Array(b.surface)
    const published = (p: WaterPublisher, d: number) => { cols.depth[0] = d; const t = p.publish([0], cols)!; return surface[t.parity * 1024]! }
    const p = new WaterPublisher(b, RETAIN)
    expect(shows(published(p, 20), 2)).toBe(false)
    expect(shows(published(p, 40), 2)).toBe(true)
    // hysteresis under retain: a drawn column stays drawn down to retain − SUB / 32, a hidden one shows from retain
    expect(shows(published(p, 31), 2)).toBe(true)
    expect(shows(published(p, 24), 2)).toBe(true)
    expect(shows(published(p, 23), 2)).toBe(false)
    expect(shows(published(p, 31), 2)).toBe(false)
    expect(shows(published(new WaterPublisher(b), 20), 2)).toBe(true)
  })

  it('only water above retain flows out', () => {
    // a column 40 deep beside dry floor keeps retain: it sends at most 8
    const fill: Fill = (x, y, z) => (y === 0 ? B.stone : AIR)
    const sim = waterSim(fill, { water: { retain: RETAIN } })
    sim.water.cols.depth[5 + 5 * 32] = 40
    sim.water.expected += 40
    sim.water.cols.tiles.wake(0)
    for (let i = 0; i < 40; i++) {
      sim.step()
      expect(sim.water.column(5, 5).depth).toBeGreaterThanOrEqual(RETAIN)
    }
    expect(sim.water.total()).toBe(40)
  })

  it('a channel still drains a lake down to retain', () => {
    // a 10 × 10 lake (x, z 1–10, floor top y 3, water y 4–5) with a flat 1-wide outlet along z 5 to x 40, where the ground
    // drops to a sea (sea level 2) reaching the world's edge
    const fill: Fill = (x, y, z) => {
      if (x > 40) return y === 0 ? B.stone : y === 1 ? w(7) : AIR
      if (y <= 3) return B.stone
      if (y > 7) return AIR
      const lake = x >= 1 && x <= 10 && z >= 1 && z <= 10, outlet = z === 5 && x >= 11
      if (!lake && !outlet) return B.stone
      return lake && y <= 5 ? w(7) : AIR
    }
    const sim = waterSim(fill, { size: [64, 32, 32], seaLevel: 2, water: { retain: RETAIN } })
    let lake = 0
    for (let z = 1; z <= 10; z++) for (let x = 1; x <= 10; x++) lake += sim.water.column(x, z).depth
    expect(lake).toBe(100 * 2 * SUB)
    run(sim, 8000)
    lake = 0
    for (let z = 1; z <= 10; z++) for (let x = 1; x <= 10; x++) lake += sim.water.column(x, z).depth
    expect(lake).toBeLessThanOrEqual(100 * (RETAIN + SUB / 16))
  }, 30_000)

  it("a spring-fed pond's edge does not flicker", () => {
    // the reviewer's repro (C1): a spring (flow 0) on the floor of a 64 × 64 basin, retain 32, a loss pass every 112 steps;
    // settled by step 20 000. Over the next 10 passes, count air ↔ water changes of the y 1 cells.
    const fill: Fill = (x, y, z) => (x === 32 && z === 32 && y === 0 ? spring(0) : basin(64, 6)(x, y, z))
    const sim = waterSim(fill, { size: [64, 32, 64], water: { retain: RETAIN, lossEvery: 112 } })
    run(sim, 20_000)
    const wet = new Uint8Array(64 * 64)
    const read = (c: number) => ((sim.store.getVoxel(c % 64, 1, Math.floor(c / 64)) & 0xfff) === B.water ? 1 : 0)
    for (let c = 0; c < wet.length; c++) wet[c] = read(c)
    const flips = new Uint8Array(64 * 64)
    let toggles = 0
    for (let i = 0; i < 1120; i++) {
      sim.step()
      for (let c = 0; c < wet.length; c++) { const v = read(c); if (v !== wet[c]) { toggles++; flips[c]++; wet[c] = v } }
    }
    expect(toggles).toBeLessThanOrEqual(TOGGLES)
    expect(Math.max(...flips)).toBeLessThanOrEqual(1) // the shore may still creep out; no cell goes back and forth
  }, 240_000)

  it('a gentle channel still reaches its end with retain', () => {
    const sim = waterSim(channel, { size: [96, 32, 32], seaLevel: 2, water: { retain: RETAIN } })
    run(sim, 4000)
    for (let x = 61; x <= 64; x++) expect(sim.water.column(x, 5).depth).toBeGreaterThanOrEqual(RETAIN)
  })

  it('a settled pool stops writing', () => {
    const sim = waterSim(poured, { size: [64, 32, 64], water: { retain: RETAIN } })
    settle(sim)
    const epochs = sim.epochs.slice()
    for (let i = 0; i < 200; i++) {
      const r = sim.step()
      expect(sim.water.stats().tiles).toBe(0)
      if (i > 0) expect(r.water).toBeNull() // the first flush republishes the last publish's tiles into the other parity
    }
    expect([...sim.epochs]).toEqual([...epochs])
  })

  it('retain unset is today\'s water', () => {
    const scenarios: [Fill, [number, number, number], number | undefined][] = [
      [poured, [64, 32, 64], undefined], [channel, [96, 32, 32], 2], [pit, [32, 32, 32], undefined],
    ]
    for (const [fill, size, seaLevel] of scenarios) {
      const a = waterSim(fill, { size, seaLevel }), b = waterSim(fill, { size, seaLevel, water: { retain: 4 } })
      run(a, 300)
      run(b, 300)
      expect(b.hash()).toBe(a.hash())
    }
  })
})
