import assert from 'node:assert/strict'
import { cpus } from 'node:os'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { workersGenerator, WORKER_OPTIONS } from '../../../apps/sandbox/src/scenes/workers.ts'
import { BLOCKS } from '../../../apps/sandbox/src/blocks.ts'

const summarize = (values: number[]) => {
  const a = [...values].sort((a, b) => a - b)
  return { p50: +a[Math.floor(a.length * .5)]!.toFixed(3), p95: +a[Math.ceil(a.length * .95) - 1]!.toFixed(3), p99: +a[Math.ceil(a.length * .99) - 1]!.toFixed(3), max: +a.at(-1)!.toFixed(3) }
}
if (process.argv.includes('--scene')) {
  const sim = new Simulation({ buffers: createWorldBuffers([128, 64, 128]), blocks: BLOCKS, seed: 1, randomTicksPerChunk: 0, workers: WORKER_OPTIONS })
  sim.generate(workersGenerator)
  for (let i = 0; i < 8; i++) sim.submit(0, i, { type: 'unitSpawn', pos: [12 + i % 4 * 2, 5, 27 + Math.floor(i / 4) * 3], tools: ['pick'], stock: [{ block: sim.registry.id('planks'), count: 32 }] })
  sim.step(); sim.submit(0, 9, { type: 'workDig', min: [22, 5, 29], max: [26, 6, 29] })
  for (let i = 0; i < 1200; i++) { const r = sim.step(); if (r.workers!.orders[0]?.done === 10) break }
  assert.equal(sim.workers!.publication().orders[0]?.done, 10, 'tunnel')
  sim.submit(0, 10, { type: 'workBuild', min: [42, 4, 30], max: [46, 4, 30], voxel: sim.registry.id('planks') })
  for (let i = 0; i < 1200; i++) { const r = sim.step(); if (r.workers!.orders[0]?.done === 5) break }
  assert.equal(sim.workers!.publication().orders[0]?.done, 5, 'bridge')
  sim.submit(0, 11, { type: 'workBuild', min: [32, 5, 28], max: [36, 6, 28], voxel: sim.registry.id('planks') })
  for (let i = 0; i < 1200; i++) { const r = sim.step(); if (r.workers!.orders[0]?.done === 10) break }
  assert.equal(sim.workers!.publication().orders[0]?.done, 10, 'wall')
  console.log(JSON.stringify({ orders: sim.workers!.publication().orders, units: [...sim.workers!.units.values()].map(u => ({ ...sim.workers!.view(u.id), goal: u.goal, path: u.path.slice(u.cursor), wait: u.wait, task: u.task?.pos })) }, null, 2))
} else {
  const report = []
  for (const count of [0, 1, 100, 1000]) {
    const sim = new Simulation({ buffers: createWorldBuffers([256, 128, 256]), blocks: [{ name: 'stone' }], seed: 1, randomTicksPerChunk: 0, workers: count ? { searchCap: 4096 } : undefined })
    sim.generate({ generateColumn(ctx) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) ctx.set(x, y, z, 1) } })
    for (let i = 0; i < count; i++) sim.submit(0, i, { type: 'unitSpawn', pos: [4 + i % 32 * 2, 4, 4 + Math.floor(i / 32) * 2] })
    const spawned = sim.step(); assert.ok(spawned.acks.every(a => a.ok))
    const idle: number[] = [], walking: number[] = [], awake = new Set<number>()
    let peakBytes = 0, peakPayload = 0
    for (let i = 0; i < 120; i++) { const t = performance.now(); sim.step(); if (i >= 20) idle.push(performance.now() - t) }
    if (!count) { report.push({ count, idle: summarize(idle) }); continue }
    sim.submit(0, count + 1, { type: 'unitMove', ids: [...sim.workers!.units.keys()], pos: [180, 4, 130] })
    for (let i = 0; i < 240; i++) {
      const t = performance.now(), r = sim.step(); walking.push(performance.now() - t)
      assert.ok(r.workers!.stats.visited <= 4096)
      for (const u of sim.workers!.units.values()) if (u.state === 'walking') awake.add(u.id)
      peakBytes = Math.max(peakBytes, r.workers!.stats.navBytes); peakPayload = Math.max(peakPayload, r.workers!.poses.byteLength)
    }
    report.push({ count, idle: summarize(idle), moving: summarize(walking), firstActionsWithin240Ticks: awake.size, stateCounts: [...sim.workers!.units.values()].reduce((n, u) => { n[u.state] = (n[u.state] ?? 0) + 1; return n }, {} as Record<string, number>), peakTypedNavBytes: peakBytes, peakPosePayload: peakPayload })
  }
  console.log(JSON.stringify({ date: '2026-10-07', node: process.version, cpu: cpus()[0]?.model, size: [256, 128, 256], searchCap: 4096, scope: 'Complete Simulation ticks including worker publication, light and commit. No GPU or worker transport; moving includes initial cold queries, traffic and reconstruction. Memory metric includes typed nav arrays only.', results: report }, null, 2))
}
