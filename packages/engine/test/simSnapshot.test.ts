import { describe, expect, it } from 'vitest'
import { Scheduler } from '../src/sim/scheduler.ts'
import { fullRestore, richScript, richSim, restored, voxelsEqual } from './persistHelpers.ts'

describe('scheduler entries', () => {
  it('restores the same drain order and keeps counting', () => {
    const a = new Scheduler()
    a.schedule(5, 10); a.schedule(3, 4); a.schedule(9, 10); a.schedule(5, 7) // 5 moves earlier
    const { pairs, seq } = a.entries()
    const b = new Scheduler(); b.restore(pairs, seq)
    expect(b.size).toBe(3)
    expect(b.entries().seq).toBe(seq)
    expect(b.drain(100, 10)).toEqual(a.drain(100, 10))
  })
})

describe('simulation snapshot', () => {
  it('restores voxels, tick and the scheduler; two loads continue identically', () => {
    const sim = richSim()
    for (let t = 0; t < 10; t++) { richScript(sim, t); sim.step() }
    expect(sim.pendingWork).toBeGreaterThan(0)
    const a = fullRestore(sim), b = fullRestore(sim)
    expect(a.tick).toBe(sim.tick)
    expect(voxelsEqual(a, sim)).toBe(true)
    expect(a.pendingWork).toBe(sim.pendingWork)
    for (let t = 0; t < 40; t++) { a.step(); b.step() }
    expect(a.hash()).toBe(b.hash())
  })
  it('keeps the paused flag', () => {
    const sim = richSim(); sim.setPaused(true)
    expect(fullRestore(sim).paused).toBe(true)
  })
  it('copies only regions written since the baseline', () => {
    const sim = richSim()
    const first = sim.snapshot(null)
    expect(first.regions.length).toBe(1) // 64² is one region
    expect(sim.snapshot(first.revisions).regions.length).toBe(0)
    sim.submit(0, 1, { type: 'setBlock', pos: [1, 20, 1], voxel: 1 }); sim.step()
    expect(sim.snapshot(first.revisions).regions.length).toBe(1)
  })
  it('starts a restored world with zero revisions', () => {
    const r = restored(richSim().snapshot(null))
    expect([...r.store.regionRevisions]).toEqual([0])
  })
})
