import { describe, expect, it } from 'vitest'
import type { GeneratorContext } from '../src/sim/generator.ts'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { AIR } from '../src/world/voxel.ts'

const blocks = [{ name: 'stone' }, { name: 'beam', collapses: true }, { name: 'sand', falls: true }, { name: 'water', liquid: true }]
const options = () => ({ buffers: createWorldBuffers([64, 32, 32]), blocks, seed: 17, randomTicksPerChunk: 0, log: () => {} })
const gen = { generateColumn(ctx: GeneratorContext) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) ctx.set(x, 0, z, 1) } }
function make(): Simulation { const s = new Simulation(options()); s.generate(gen); return s }
function load(src: Simulation): Simulation {
  const snap = src.snapshot(null), s = new Simulation(options())
  s.restore({ tick: snap.tick, paused: snap.paused, regions: snap.regions, sections: Object.fromEntries(snap.sections.map(x => [x.name, x.bytes])) })
  return s
}
/** A beam on one stone post, then the post taken away: the beam leaves the grid as a fragment. */
function bridge(s: Simulation): void {
  s.submit(0, 1, { type: 'fillRegion', min: [10, 1, 10], max: [10, 9, 10], voxel: 1 })
  s.submit(0, 2, { type: 'fillRegion', min: [10, 10, 10], max: [16, 10, 10], voxel: 2 })
  s.step()
  s.submit(0, 3, { type: 'fillRegion', min: [10, 1, 10], max: [10, 9, 10], voxel: AIR })
}

describe('falling bodies and fragments in a save', () => {
  it('keeps sand in mid-air falling where it was', () => {
    const a = make()
    a.submit(0, 1, { type: 'setBlock', pos: [5, 25, 5], voxel: 3 })
    for (let t = 0; t < 6; t++) a.step()
    expect(a.gravity.count).toBe(1)
    const b = load(a)
    expect(b.gravity.snapshot()).toEqual(a.gravity.snapshot())
    for (let t = 0; t < 60; t++) b.step()
    expect(b.store.getVoxel(5, 1, 5)).toBe(3)
  })
  it('keeps a falling fragment, announces it again, and lands it', () => {
    const a = make()
    bridge(a)
    for (let t = 0; a.collapse.stats().fragments === 0 && t < 200; t++) a.step()
    a.step(); a.step()
    expect(a.collapse.stats().fragments).toBe(1)
    const b = load(a)
    expect(b.collapse.stats().fragments).toBe(1)
    expect(b.step().collapse?.born.length).toBe(1)
    for (let i = 0; i < 200 && b.collapse.busy; i++) b.step()
    expect(b.collapse.stats().fragments).toBe(0)
    let beams = 0
    for (let x = 10; x <= 16; x++) if ((b.store.getVoxel(x, 1, 10) & 0xfff) === 2) beams++
    expect(beams).toBe(7)
  })
  it('two loads of a save taken while support checks run continue identically', () => {
    const a = make()
    bridge(a)
    a.step()
    const b = load(a), c = load(a)
    for (let t = 0; t < 150; t++) { b.step(); c.step() }
    expect(b.hash()).toBe(c.hash())
    expect(b.collapse.stats().fragments + b.collapse.stats().checks).toBe(0)
  })
})
