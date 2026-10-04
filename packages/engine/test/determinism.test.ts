import { describe, expect, it } from 'vitest'
import { defineBlock } from '../src/blocks/registry.ts'
import type { StampedCommand } from '../src/sim/commands.ts'
import { defineRules } from '../src/sim/rules.ts'
import { Simulation } from '../src/sim/simulation.ts'
import { testGenerator } from '../src/sim/testGenerator.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { AIR } from '../src/world/voxel.ts'
import { TEST_BLOCKS } from './helpers.ts'

const BLOCKS = [
  ...TEST_BLOCKS, defineBlock({ name: 'sand' }), defineBlock({ name: 'gravel', falls: true }),
  defineBlock({ name: 'spring', liquid: true, source: 'water', textures: 'water' }),
]
const GRAVEL = 9, SPRING = 10
/** Counts world changes made by the random-tick rule, per sim, so the test cannot go vacuous. */
function makeRules(counter: { n: number }) { return defineRules({
  blocks: {
    sand: {
      onNeighborChanged(ctx, x, y, z) { ctx.schedule(x, y, z, 1 + Math.floor(ctx.random() * 3)) },
      onScheduledTick(ctx, x, y, z, v) {
        if (y > 0 && ctx.isAir(ctx.get(x, y - 1, z))) { ctx.set(x, y, z, AIR); ctx.set(x, y - 1, z, v) }
      },
    },
    grass: {
      onRandomTick(ctx, x, y, z) {
        const dx = ctx.random() < 0.5 ? -1 : 1
        if (ctx.get(x + dx, y, z) === ctx.id('dirt') && ctx.isAir(ctx.get(x + dx, y + 1, z))) { ctx.set(x + dx, y, z, ctx.id('grass')); counter.n++ }
        // Exposed grass withers to dirt half the time; fires often enough to pin random-tick positions.
        else if (ctx.isAir(ctx.get(x, y + 1, z)) && ctx.random() < 0.5) { ctx.set(x, y, z, ctx.id('dirt')); counter.n++ }
      },
    },
  },
  commands: {
    // Writes, then throws: the partial effect must survive and be reproduced on replay.
    setThenThrow(ctx) {
      ctx.set(5, 1, 5, ctx.id('glass'))
      ctx.set(6, 1, 5, ctx.id('glass'))
      throw new Error('half done')
    },
  },
}) }

function makeSim(seed = 77, counter = { n: 0 }) {
  const sim = new Simulation({ buffers: createWorldBuffers([64, 64, 64]), blocks: BLOCKS, rules: makeRules(counter), seed, log: () => {} })
  sim.generate(testGenerator)
  return sim
}

/** A scripted session: drop sand, dig holes, expose dirt for grass to spread onto. */
function script(sim: Simulation, t: number): void {
  if (t % 10 === 0) sim.submit(1, t, { type: 'setBlock', pos: [(t * 7) % 64, 60, (t * 13) % 64], voxel: 8 })
  if (t % 25 === 0) sim.submit(2, t, { type: 'fillRegion', min: [(t * 3) % 60, 20, 10], max: [(t * 3) % 60 + 3, 40, 13], voxel: AIR })
  if (t % 15 === 5) sim.submit(4, t, { type: 'setBlock', pos: [(t * 11) % 64, 58, (t * 5) % 64], voxel: (7 << 12) | 5 }) // full water
  if (t % 20 === 7) sim.submit(5, t, { type: 'fillRegion', min: [(t * 17) % 60, 50, 30], max: [(t * 17) % 60, 52, 30], voxel: GRAVEL })
  if (t === 30) sim.submit(6, t, { type: 'setBlock', pos: [32, 62, 32], voxel: (5 << 12) | SPRING })
  if (t === 50) sim.submit(3, t, { type: 'setThenThrow' })
  if (t === 100) sim.submit(1, 9999, { type: 'setBlock', pos: [0, 99, 0], voxel: 1 }) // rejected: out of bounds
}

function run(sim: Simulation, ticks: number): number {
  for (let t = 0; t < ticks; t++) { script(sim, t); sim.step() }
  return sim.hash()
}

function replay(log: readonly StampedCommand[], ticks: number): number {
  const sim = makeSim()
  let i = 0
  for (let t = 0; t < ticks; t++) {
    while (i < log.length && log[i]!.tick === t) { const c = log[i++]!; sim.submit(c.clientId, c.seq, c.cmd) }
    sim.step()
  }
  return sim.hash()
}

describe('determinism', () => {
  it('produces the same world hash for the same seed and commands', () => {
    const ca = { n: 0 }
    const a = makeSim(77, ca)
    const b = makeSim()
    const ha = run(a, 500)
    const hb = run(b, 500)
    expect(ha).toBe(hb)
    expect(a.fluids.totalVolume()).toBeGreaterThan(0) // water and the spring really ran
    expect(ca.n).toBeGreaterThan(20) // the random-tick rule really changed the world
    expect(a.commandLog.some((c) => c.cmd.type === 'setThenThrow')).toBe(true)
    expect(a.store.getVoxel(5, 1, 5)).toBe(4) // the failing handler's partial effect (glass) stuck
    expect(replay(a.commandLog, 500)).toBe(ha)
  }, 60_000)

  it('diverges for a different seed', () => {
    expect(run(makeSim(77), 200)).not.toBe(run(makeSim(78), 200))
  }, 60_000)
})
