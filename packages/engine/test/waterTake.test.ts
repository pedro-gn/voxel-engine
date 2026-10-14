import { describe, expect, it } from 'vitest'
import { SUB } from '../src/sim/water/constants.ts'
import { Simulation } from '../src/sim/simulation.ts'
import type { GameSystem, SystemContext } from '../src/sim/systems.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, WATER_BLOCKS, depthSum, fillGenerator, lake, spring, w, type Fill } from './waterHelpers.ts'

/** A water world (32³ unless `size` says otherwise) with a test system; `take` runs takeWater inside the next system tick. */
function harness(fill: Fill, o: { size?: [number, number, number]; seaLevel?: number } = {}) {
  let script: ((c: SystemContext) => void) | null = null
  const sys: GameSystem = { name: 'test', version: 1, snapshot: () => null, tick: c => { const s = script; script = null; s?.(c) } }
  const make = () => new Simulation({ buffers: createWorldBuffers(o.size ?? [32, 32, 32]), blocks: WATER_BLOCKS, seed: 1, randomTicksPerChunk: 0, log: () => {}, systems: [sys] })
  const sim = make()
  const gen = fillGenerator(fill, o.seaLevel)
  sim.configure(gen, null)
  sim.generate(gen)
  const take = (x: number, y: number, z: number, amount: number): number => {
    let out = -1
    script = c => { out = c.takeWater(x, y, z, amount) }
    sim.step()
    return out
  }
  /** Steps until no water tile is awake. */
  const settle = (max = 20_000) => { for (let i = 0; i < max; i++) if (!sim.step().physics.busy) return; throw new Error('water still moving') }
  /** A copy of the world through a save, with the same test system. */
  const reload = (): Simulation => {
    const snap = sim.snapshot(null), b = make()
    b.configure(fillGenerator(fill, o.seaLevel), null)
    b.restore({ tick: snap.tick, paused: snap.paused, regions: snap.regions, sections: Object.fromEntries(snap.sections.map(x => [x.name, x.bytes])) })
    return b
  }
  return { sim, take, settle, reload }
}

describe('takeWater', () => {
  it('taking from a closed pond lowers it by exactly that volume', () => {
    const h = harness(lake(1, 6, 3)) // a 4 × 4 basin (x, z 1–4), one block of water at y 1
    h.settle()
    expect(depthSum(h.sim, 1, 1, 4, 4)).toBe(16 * SUB)
    expect(h.take(2, 1, 2, SUB)).toBe(SUB)
    h.settle()
    expect(depthSum(h.sim, 1, 1, 4, 4)).toBe(16 * SUB - SUB)
    expect(h.sim.water.total()).toBe(h.sim.water.expected)
    expect(h.sim.water.check()).toEqual([])
  })

  it('asking more than there is takes what there is', () => {
    // a one-column pit (5, 1, 5) in stone, full of water
    const h = harness((x, y, z) => (y === 1 && x === 5 && z === 5 ? w(7) : y <= 1 ? B.stone : AIR))
    h.settle()
    expect(h.take(5, 1, 5, SUB - 100)).toBe(SUB - 100) // leaves a puddle of 100
    expect(h.sim.water.depthAt(5, 1, 5)).toBe(100)
    expect(h.take(5, 1, 5, 500)).toBe(100)
    expect(h.sim.water.column(5, 5).depth).toBe(0)
    expect(h.sim.water.check()).toEqual([])
  })

  it('a dry cell, out of bounds, and a non-positive amount take nothing', () => {
    const h = harness(lake(1, 6, 3))
    h.settle()
    const total = h.sim.water.total()
    expect(h.take(10, 1, 10, SUB)).toBe(0) // dry ground
    expect(h.take(2, 2, 2, SUB)).toBe(0) // above the pond's surface
    expect(h.take(-1, 1, 2, SUB)).toBe(0)
    expect(h.take(2, 40, 2, SUB)).toBe(0)
    expect(h.take(2, 1, 2, 0)).toBe(0)
    expect(h.take(2, 1, 2, -5)).toBe(0)
    expect(h.sim.water.total()).toBe(total)
    expect(depthSum(h.sim, 1, 1, 4, 4)).toBe(16 * SUB)
    expect(h.sim.water.check()).toEqual([])
  })

  it('a spring refills what is taken', () => {
    // Sea (level 3) for z ≥ 24. Land solid to y 4; a 4 × 4 pit (x, z 5–8, cell y 4) with a spring under (5, 5) and a
    // channel (x 7, z 9–23, cell y 4) from the pit down into the sea.
    const fill: Fill = (x, y, z) => {
      if (y === 0) return B.stone
      if (z >= 24) return y <= 2 ? w(7) : AIR
      if (x === 5 && z === 5 && y === 3) return spring(4)
      const pit = x >= 5 && x <= 8 && z >= 5 && z <= 8, channel = x === 7 && z >= 9 && z <= 23
      if ((pit || channel) && y === 4) return AIR
      return y <= 4 ? B.stone : AIR
    }
    const h = harness(fill, { seaLevel: 3 })
    for (let t = 0; t < 600; t++) h.sim.step()
    const pond = () => depthSum(h.sim, 5, 5, 8, 8)
    const before = pond()
    expect(before).toBeGreaterThan(4 * SUB)
    let taken = 0
    for (let k = 0; k < 8; k++) taken += h.take(6 + (k & 1), 4, 6 + ((k >> 1) & 1), SUB)
    expect(taken).toBeGreaterThan(SUB)
    expect(h.sim.water.check()).toEqual([])
    let back = false
    for (let t = 0; t < 600; t++) {
      h.sim.step()
      expect(h.sim.water.total()).toBe(h.sim.water.expected) // Σ depth + sea, the sea paying for the spring
      if (pond() >= before - SUB / 8) back = true
    }
    expect(back).toBe(true)
  })

  it('underground segment: a sealed body\'s shared level drops by volume ÷ area', () => {
    // a sealed 6 × 6 chamber (x, z 3–8), cells y 4–6 full of water, in stone
    const h = harness((x, y, z) => (y >= 4 && y <= 6 && x >= 3 && x <= 8 && z >= 3 && z <= 8 ? w(7) : y <= 12 ? B.stone : AIR))
    h.settle()
    expect(h.sim.water.bodies.list.length).toBe(1)
    expect(h.sim.water.segments(5, 5)[0]).toMatchObject({ floor: 4, ceil: 7, depth: 3 * SUB })
    expect(h.take(5, 5, 5, 36 * 8)).toBe(36 * 8)
    h.settle()
    let sum = 0
    for (let z = 3; z <= 8; z++) for (let x = 3; x <= 8; x++) {
      const s = h.sim.water.segments(x, z)[0]!
      sum += s.depth
      expect(Math.abs(s.depth - (3 * SUB - 8))).toBeLessThanOrEqual(8)
    }
    expect(sum).toBe(36 * 3 * SUB - 36 * 8)
    expect(h.sim.water.check()).toEqual([])
  })

  it('save/load: the water taken stays taken (no new state)', () => {
    const h = harness(lake(1, 6, 3))
    h.settle()
    h.take(2, 1, 2, 3 * SUB / 2)
    for (let t = 0; t < 5; t++) h.sim.step()
    const b = h.reload()
    expect([...b.water.cols.state().depth]).toEqual([...h.sim.water.cols.state().depth])
    expect(b.water.total()).toBe(h.sim.water.total())
    expect(b.water.check()).toEqual([])
  })
})
