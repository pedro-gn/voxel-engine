import { bench, describe } from 'vitest'
import { defineBlock } from '../src/blocks/registry.ts'
import { defineRules } from '../src/sim/rules.ts'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { TEST_BLOCKS } from '../test/helpers.ts'

describe('simulation tick', () => {
  const blocks = [...TEST_BLOCKS, defineBlock({ name: 'ticker' })]
  const rules = defineRules({
    blocks: {
      ticker: {
        onNeighborChanged(ctx, x, y, z) { ctx.schedule(x, y, z, 1) },
        onScheduledTick(ctx, x, y, z) { ctx.schedule(x, y, z, 1) },
      },
    },
  })
  const sim = new Simulation({ buffers: createWorldBuffers([256, 64, 256]), blocks, rules, seed: 1, workCap: 200_000 })
  let seq = 0
  for (let x = 0; x < 100; x++) for (let z = 0; z < 100; z++) sim.submit(0, seq++, { type: 'setBlock', pos: [x * 2, 40, z * 2], voxel: 8 })
  sim.step()
  sim.step() // steady state: 10 000 scheduled updates per tick
  bench('tick with 10k scheduled updates', () => { sim.step() }, { time: 2000 })
})
