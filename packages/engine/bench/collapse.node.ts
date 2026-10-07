// Complete sim-worker CPU costs (including lighting, commit and publication), without browser rendering.
// Run: node packages/engine/bench/collapse.node.ts; BENCH_ASSERT=1 gates tick p95 <= 10 ms.
import assert from 'node:assert/strict'
import { cpus } from 'node:os'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'

const cases = [{ name: 'small-deck', side: 16, depth: 1 }, { name: 'dense-slab', side: 96, depth: 4 }, { name: 'wide-thin-slab', side: 192, depth: 1 }]
const report: unknown[] = []
for (const c of cases) {
  const logs: string[] = []
  const sim = new Simulation({ buffers: createWorldBuffers([256, 96, 256]), blocks: [{ name: 'stone' }, { name: 'beam', collapses: true }, { name: 'water', liquid: true }], seed: 1, randomTicksPerChunk: 0, log: m => logs.push(m) })
  const count = c.side * c.side * c.depth
  sim.generate({ generateColumn(ctx, cx, cz) {
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
      const wx = cx * 32 + x, wz = cz * 32 + z
      ctx.set(x, 0, z, 1)
      if (wx >= 16 && wx < 16 + c.side && wz >= 16 && wz < 16 + c.side) for (let y = 40; y < 40 + c.depth; y++) ctx.set(x, y, z, 2)
      if (wx === 15 && wz === 16) ctx.set(x, 40, z, 1)
    }
  } })
  for (let i = 0; i < 1000; i++) if (!sim.step().physics.busy) break
  assert.equal(sim.collapse.busy, false, 'supported structure must settle')
  sim.submit(0, 1, { type: 'setBlock', pos: [15, 40, 16], voxel: 0 })
  const times: number[] = [], phases: number[] = []
  let phase = 0, firstBirth = -1, settled = -1, peak = 0, payloadBytes = 0
  const step = sim.collapse.step.bind(sim.collapse)
  sim.collapse.step = () => { const t = performance.now(); step(); phase = performance.now() - t }
  for (let tick = 0; tick < 5000; tick++) {
    const t = performance.now(), r = sim.step()
    times.push(performance.now() - t); phases.push(phase)
    const stats = r.physics.collapse!
    assert.ok(stats.visited <= 4096 && stats.mutations <= 128 && stats.fragments <= 64)
    peak = Math.max(peak, stats.fragments)
    if (r.collapse) {
      if (r.collapse.born.length && firstBirth < 0) firstBirth = tick
      payloadBytes += r.collapse.poses.byteLength
      for (const b of r.collapse.born) payloadBytes += b.positions.byteLength + b.voxels.byteLength
    }
    if (!r.physics.busy) { settled = tick; break }
  }
  assert.ok(settled >= 0, `${c.name}: did not settle; ${JSON.stringify(sim.collapse.stats())}; firstBirth=${firstBirth}; peak=${peak}; payloadBytes=${payloadBytes}`)
  let final = 0
  const scratch = new Uint16Array(32768)
  for (let ci = 0; ci < sim.layout.chunkCount; ci++) for (const v of sim.store.readVoxels(ci, scratch)) if ((v & 0xfff) === 2) final++
  assert.equal(final, count); assert.deepEqual(logs, [])
  const summarize = (samples: number[]) => {
    samples.sort((a, b) => a - b)
    return { p50: +samples[Math.floor(samples.length * .5)].toFixed(3), p95: +samples[Math.ceil(samples.length * .95) - 1].toFixed(3), max: +samples.at(-1)!.toFixed(3) }
  }
  const tick = summarize(times)
  if (process.env.BENCH_ASSERT) assert.ok(tick.p95 <= 10, `${c.name}: tick p95 ${tick.p95} ms > 10 ms`)
  report.push({ ...c, count, tick, collapse: summarize(phases), firstBirthTick: firstBirth, settledTick: settled, peakFragments: peak, payloadBytes })
}
console.log(JSON.stringify({ node: process.version, cpu: cpus()[0].model, waterEnabled: true, scanCap: 4096, mutationCap: 128, fragmentCells: 128, results: report }, null, 2))
