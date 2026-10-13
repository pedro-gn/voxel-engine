import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, WATER_BLOCKS, fillGenerator, lake, spring, w, type Fill } from './waterHelpers.ts'

const options = () => ({ buffers: createWorldBuffers([64, 32, 64]), blocks: WATER_BLOCKS, seed: 1, randomTicksPerChunk: 0, log: () => {} })
function sim(fill: Fill): Simulation {
  const s = new Simulation(options())
  const gen = fillGenerator(fill); s.configure(gen, null); s.generate(gen); return s
}
function restore(src: Simulation, fill: Fill): Simulation {
  const snap = src.snapshot(null)
  const s = new Simulation(options())
  s.configure(fillGenerator(fill), null)
  s.restore({ tick: snap.tick, paused: snap.paused, regions: snap.regions, sections: Object.fromEntries(snap.sections.map(x => [x.name, x.bytes])) })
  return s
}
const cols = (s: Simulation) => s.water.cols.state()
const waterSection = (s: Simulation) => s.snapshot(null).sections.find(x => x.name === 'water')!.bytes

describe('water snapshot', () => {
  it('continues a moving flood with no jump: depth, flux and the sea account are exact at load', () => {
    const fill = lake(6, 12, 8)
    const a = sim(fill)
    a.submit(0, 1, { type: 'fillRegion', min: [11, 1, 3], max: [11, 7, 6], voxel: AIR }) // breach
    for (let t = 0; t < 25; t++) a.step()
    expect(a.water.stats().tiles).toBeGreaterThan(0)
    const b = restore(a, fill)
    expect([...cols(b).depth]).toEqual([...cols(a).depth])
    expect([...cols(b).flux]).toEqual([...cols(a).flux])
    expect(b.water.sea).toBe(a.water.sea)
    expect(b.water.stats().tiles).toBe(a.water.stats().tiles)
    expect(b.water.check()).toEqual([])
    const c = restore(a, fill)
    for (let t = 0; t < 200; t++) { b.step(); c.step() }
    expect(b.hash()).toBe(c.hash())
    expect(b.water.check()).toEqual([])
  })
  it('keeps springs in order and lower segments with their water', () => {
    // A roofed pocket of water (lower segments under the roof) and a spring under open sky.
    const fill: Fill = (x, y, z) => {
      if (y === 0) return B.stone
      const inside = x >= 20 && x < 30 && z >= 20 && z < 30
      if (inside && y === 6) return B.stone
      if (inside && y >= 1 && y <= 3) return w(7)
      if (x === 40 && z === 40 && y === 1) return spring(4)
      if (x === 44 && z === 40 && y === 1) return spring(2)
      return AIR
    }
    const a = sim(fill)
    for (let t = 0; t < 30; t++) a.step()
    expect(a.water.segments(25, 25).length).toBeGreaterThan(1)
    const b = restore(a, fill)
    expect([...b.water.cycle.springs]).toEqual([...a.water.cycle.springs])
    expect(b.water.segments(25, 25)).toEqual(a.water.segments(25, 25))
    expect(b.water.check()).toEqual([])
  })
  it('save → load → save gives the same water section', () => {
    const fill = lake(6, 12, 8)
    const a = sim(fill)
    a.submit(0, 1, { type: 'fillRegion', min: [11, 1, 3], max: [11, 7, 6], voxel: AIR })
    for (let t = 0; t < 15; t++) a.step()
    expect(waterSection(restore(a, fill))).toEqual(waterSection(a))
  })
})
