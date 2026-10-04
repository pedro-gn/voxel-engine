import { Simulation } from '@elovox/engine/src/sim/simulation.ts'
import { createWorldBuffers } from '@elovox/engine/src/world/buffers.ts'
import { terrainGenerator } from '@elovox/terrain'
import { describe, expect, it } from 'vitest'
import { BLOCKS } from '../src/blocks.ts'
import rules from '../src/rules.ts'
import e2eDoc from '../src/terrain/e2e.terrain.json'

describe('natural water soak', () => {
  it('the e2e document\'s river and lakes run 3000 ticks without losing a unit', () => {
    // Its stepped river pools drop layers in the same fluid step as their neighbours: each split must keep
    // to its own pool's cells (before the fix, two pools emptied with −4 and −17 units unplaced by tick 20).
    const logs: string[] = []
    const sim = new Simulation({
      buffers: createWorldBuffers([e2eDoc.size[0]!, 128, e2eDoc.size[1]!]), blocks: BLOCKS, rules, seed: 1234,
      randomTicksPerChunk: 0, log: (m) => logs.push(m),
    })
    sim.configure(terrainGenerator, e2eDoc)
    sim.generate(terrainGenerator)
    expect(sim.fluids.pools.count).toBeGreaterThan(1)
    // seaLevel 24 with no sea at 23: its river-head spring has no sea to draw from and gives nothing, so volume is exact
    expect(sim.fluids.springs.size).toBe(1)
    const v0 = sim.fluids.totalVolume()
    for (let t = 0; t < 3000; t++) sim.step()
    expect(logs).toEqual([])
    expect(sim.fluids.lost).toBe(0)
    expect(sim.fluids.totalVolume()).toBe(v0)
    expect(sim.fluids.checkInvariants()).toEqual([])
  }, 20_000)
})
