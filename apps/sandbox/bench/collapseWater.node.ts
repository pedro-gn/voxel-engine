// Exercise collapse during the real dam break, with exact water accounting on every tick.
// Run from repo root: node apps/sandbox/bench/collapseWater.node.ts
import assert from 'node:assert/strict'
import { Simulation } from '@elovox/engine/src/sim/simulation.ts'
import { createWorldBuffers } from '@elovox/engine/src/world/buffers.ts'
import { BLOCKS } from '../src/blocks.ts'
import { FLOOD_SIZE, floodGenerator, breachCommands, stopSpringCommands } from '../src/scenes/flood.ts'

const rows: unknown[] = []
for (const collapse of [false, true]) {
  const blocks = collapse ? BLOCKS : BLOCKS.map(d => ({ ...d, collapses: false }))
  const errors: string[] = []
  const sim = new Simulation({ buffers: createWorldBuffers(FLOOD_SIZE), blocks, seed: 1, randomTicksPerChunk: 0, log: m => errors.push(m) })
  const generator = {
    configure: floodGenerator.configure,
    generateColumn(ctx: Parameters<typeof floodGenerator.generateColumn>[0], cx: number, cz: number) {
      floodGenerator.generateColumn(ctx, cx, cz)
      for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
        const wx = cx * 32 + x, wz = cz * 32 + z
        if (wx >= 180 && wx < 220 && wz >= 70 && wz < 110) ctx.set(x, 40, z, ctx.id('structural_planks'))
        if (wx === 179 && wz === 70) ctx.set(x, 40, z, ctx.id('stone'))
      }
    },
  }
  sim.configure(generator, {}); sim.generate(generator)
  const volume = sim.water.total()
  const commands = [...stopSpringCommands(sim.registry.id('stone')), ...breachCommands(), { type: 'setBlock' as const, pos: [179, 40, 70] as const, voxel: 0 }]
  commands.forEach((c, i) => sim.submit(0, i, c))
  let peak = 0, births = 0, peakWaterTiles = 0, restarts = 0
  const times: number[] = []
  for (let tick = 0; tick < 600; tick++) {
    const t = performance.now(), r = sim.step(); times.push(performance.now() - t)
    assert.equal(sim.water.total(), volume, `water volume at tick ${tick}`)
    peak = Math.max(peak, r.physics.collapse?.fragments ?? 0); peakWaterTiles = Math.max(peakWaterTiles, r.physics.waterTiles)
    restarts = r.physics.collapse?.restarts ?? 0
    for (const b of r.collapse?.born ?? []) births += b.positions.length
  }
  assert.equal(sim.collapse.busy, false); assert.ok(peakWaterTiles > 0); assert.deepEqual(errors, []); assert.deepEqual(sim.water.check(), [])
  if (collapse) assert.ok(births >= 1600)
  times.sort((a, b) => a - b)
  const p95 = times[Math.ceil(times.length * .95) - 1]
  if (process.env.BENCH_ASSERT) assert.ok(p95 <= 10)
  rows.push({ collapse, ticks: times.length, tickP95: +p95.toFixed(3), tickMax: +times.at(-1)!.toFixed(3), peakFragments: peak, peakWaterTiles, structuralRestarts: restarts, cellsBorn: births, waterVolumeExact: true })
}
console.log(JSON.stringify({ results: rows }, null, 2))
