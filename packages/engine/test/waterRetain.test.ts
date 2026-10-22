import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import { WaterColumns } from '../src/sim/water/columns.ts'
import { SUB } from '../src/sim/water/constants.ts'
import { WaterPublisher } from '../src/sim/water/publish.ts'
import type { GameSystem, SystemContext } from '../src/sim/systems.ts'
import { shows } from '../src/render/water/surfaceMesh.ts'
import { createWaterBuffers } from '../src/world/waterBuffers.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, run, settle, spring, w, waterSim, type Fill } from './waterHelpers.ts'

const RETAIN = 32

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
    expect(shows(published(p, 31), 2)).toBe(false) // no hysteresis under retain
    expect(shows(published(new WaterPublisher(b), 20), 2)).toBe(true)
  })

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
