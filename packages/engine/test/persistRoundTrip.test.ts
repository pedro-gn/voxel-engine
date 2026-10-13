import { describe, expect, it } from 'vitest'
import { unpack } from '../src/persist/pack.ts'
import type { Simulation } from '../src/sim/simulation.ts'
import { fullRestore, richScript, richSim, voxelsEqual } from './persistHelpers.ts'

const sections = (s: Simulation) => Object.fromEntries(s.snapshot(null).sections.map(x => [x.name, unpack(x.bytes)]))

describe('whole-simulation save', () => {
  for (const at of [5, 11, 14, 40, 200]) {
    it(`saved at tick ${at}: two loads run identically for 400 ticks with the same later commands`, () => {
      const a = richSim()
      for (let t = 0; t < at; t++) { richScript(a, t); a.step() }
      const b = fullRestore(a), c = fullRestore(a)
      expect(voxelsEqual(a, b)).toBe(true)
      expect(b.water.check()).toEqual([])
      for (let t = at; t < at + 400; t++) { richScript(b, t); richScript(c, t); b.step(); c.step() }
      expect(b.hash()).toBe(c.hash())
      expect(b.water.check()).toEqual([])
    }, 30_000)
  }
  it('save → load → save gives identical sections and regions', () => {
    const a = richSim()
    for (let t = 0; t < 14; t++) { richScript(a, t); a.step() }
    const b = fullRestore(a)
    expect(sections(b)).toEqual(sections(a))
    expect(b.snapshot(null).regions).toEqual(a.snapshot(null).regions)
  }, 30_000)
})
