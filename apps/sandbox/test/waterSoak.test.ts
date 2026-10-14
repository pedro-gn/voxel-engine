import { Simulation, createWorldBuffers } from '@elovox/engine/testing'
import { terrainGenerator } from '@elovox/terrain'
import { describe, expect, it } from 'vitest'
import { BLOCKS } from '../src/blocks.ts'
import rules from '../src/rules.ts'
import e2eDoc from '../src/terrain/e2e.terrain.json'

describe('natural water soak', () => {
  it('the e2e document\'s river and lakes run 3000 ticks with Σ depth + sea exact and the debug check quiet', () => {
    const logs: string[] = []
    const sim = new Simulation({
      buffers: createWorldBuffers([e2eDoc.size[0]!, 128, e2eDoc.size[1]!]), blocks: BLOCKS, rules, seed: 1234,
      randomTicksPerChunk: 0, log: (m) => logs.push(m), water: { debug: true },
    })
    sim.configure(terrainGenerator, e2eDoc)
    sim.generate(terrainGenerator)
    expect(sim.water.cycle.springs.size).toBe(1) // the river-head spring, under its water
    const v0 = sim.water.total()
    for (let t = 0; t < 3000; t++) sim.step()
    expect(logs).toEqual([])
    expect(sim.water.total()).toBe(v0)
    expect(sim.water.check()).toEqual([])
  }, 60_000)
})
