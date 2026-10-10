import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import type { Command } from '../src/sim/commands.ts'
import type { WorkerOptions } from '../src/sim/workers/types.ts'
import type { GeneratorContext } from '../src/sim/generator.ts'
import { PathSearch } from '../src/sim/navigation/navigation.ts'
import { GroupField } from '../src/sim/navigation/groupField.ts'
import { RouteSearch } from '../src/sim/navigation/routeSearch.ts'

const blocks = [{ name: 'stone' }, { name: 'planks' }, { name: 'water', liquid: true }, { name: 'sand', falls: true }, { name: 'beam', collapses: true }]
/** A side × 32 × side floor at y = 4, with the navigation budget of the scale target. */
function makeWide(side: number, extra?: (ctx: GeneratorContext) => void, options: WorkerOptions = {}) {
  const sim = new Simulation({ buffers: createWorldBuffers([side, 32, side]), blocks, seed: 1, randomTicksPerChunk: 0, workers: { searchCap: 32768, materials: { stone: { digTicks: 4, buildTicks: 3 }, planks: { digTicks: 2, buildTicks: 3 } }, ...options } })
  sim.generate({ generateColumn(ctx) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) ctx.set(x, y, z, 1); extra?.(ctx) } })
  return sim
}
let seq = 0
function cmd(sim: Simulation, command: Command) { sim.submit(0, ++seq, command); const r = sim.step(); expect(r.acks[0]?.ok, r.acks[0]?.error).toBe(true); return r }
function spawn(sim: Simulation, pos = [5, 4, 5], stock: { block: number; count: number }[] = []) { cmd(sim, { type: 'unitSpawn', pos, stock }); return sim.workers!.units.size }
function until(sim: Simulation, predicate: () => boolean, cap = 500) { for (let i = 0; i < cap; i++) { if (predicate()) return; sim.step() }; expect(predicate(), JSON.stringify(sim.workers!.publication().stats)).toBe(true) }

describe('hierarchical routes', { timeout: 60_000 }, () => {
  it('walks a 200-block move through route segments and arrives', () => {
    const sim = makeWide(256); spawn(sim, [5, 4, 5])
    cmd(sim, { type: 'unitMove', ids: [1], pos: [220, 4, 200] })
    expect(sim.workers!.units.get(1)!.route?.search).toBeInstanceOf(RouteSearch)
    until(sim, () => sim.workers!.view(1)?.state === 'walking', 40) // first action within 2 s
    let peak = 0
    for (let i = 0; i < 4000 && sim.workers!.view(1)?.state !== 'idle'; i++) { const r = sim.step(); peak = Math.max(peak, r.workers!.stats.visited); expect(r.workers!.stats.visited).toBeLessThanOrEqual(32768) }
    expect(sim.workers!.view(1)).toMatchObject({ state: 'idle', x256: 220 * 256 + 128, z256: 200 * 256 + 128 })
    expect(sim.workers!.units.get(1)!.route).toBeNull()
    expect(peak).toBeGreaterThan(0)
  })
  it('a wall built across the next segment makes the unit stop safely, replan and still arrive', () => {
    const sim = makeWide(256); spawn(sim, [5, 4, 5])
    cmd(sim, { type: 'unitMove', ids: [1], pos: [220, 4, 5] })
    until(sim, () => (sim.workers!.view(1)?.x256 ?? 0) > 60 * 256, 2000)
    cmd(sim, { type: 'fillRegion', min: [100, 4, 0], max: [100, 7, 30], voxel: 1 })
    for (let i = 0; i < 6000 && sim.workers!.view(1)?.state !== 'idle'; i++) {
      sim.step()
      const v = sim.workers!.view(1)!, x = v.x256 >> 8, z = v.z256 >> 8
      // Never inside the new wall.
      expect(x === 100 && z <= 30 && v.y256 < 8 * 256).toBe(false)
    }
    expect(sim.workers!.view(1)).toMatchObject({ state: 'idle', x256: 220 * 256 + 128, z256: 5 * 256 + 128 })
  })
  it('escape from a build designation stays on the flat search', () => {
    // Spawn inside a build box, then order a long move: the first query must be a PathSearch with an allowed override.
    const sim = makeWide(256); spawn(sim, [10, 4, 10])
    cmd(sim, { type: 'workBuild', min: [8, 4, 8], max: [12, 4, 12], voxel: 2 })
    cmd(sim, { type: 'unitMove', ids: [1], pos: [200, 4, 200] })
    const u = sim.workers!.units.get(1)!
    expect(u.route).toBeNull(); expect(u.search).toBeInstanceOf(PathSearch); expect(u.escape.length).toBe(1)
  })
  it('a unit standing on sand plans its long walk on the flat search', () => {
    const sim = makeWide(256); spawn(sim, [10, 4, 10])
    cmd(sim, { type: 'fillRegion', min: [10, 3, 10], max: [10, 3, 10], voxel: 4 })
    cmd(sim, { type: 'unitMove', ids: [1], pos: [200, 4, 200] })
    const u = sim.workers!.units.get(1)!
    expect(u.route).toBeNull(); expect(u.search).toBeInstanceOf(PathSearch)
  })
  it('a group move resolves every unit from one group field and every unit arrives', () => {
    const sim = makeWide(256)
    for (let i = 0; i < 20; i++) spawn(sim, [4 + (i % 5) * 2, 4, 4 + Math.floor(i / 5) * 2])
    cmd(sim, { type: 'unitMove', ids: [...sim.workers!.units.keys()], pos: [200, 4, 200] })
    const fields = new Set([...sim.workers!.units.values()].map(u => u.route?.search))
    expect(fields.size).toBe(1); expect([...fields][0]).toBeInstanceOf(GroupField)
    until(sim, () => [...sim.workers!.units.values()].every(u => u.state === 'walking' || u.state === 'idle'), 60)
    until(sim, () => [...sim.workers!.units.values()].every(u => u.state === 'idle'), 6000)
    const goals = new Set([...sim.workers!.units.values()].map(u => `${u.x >> 8},${u.z >> 8}`))
    expect(goals.size).toBe(20)
    for (const u of sim.workers!.units.values()) { expect(Math.abs((u.x >> 8) - 200)).toBeLessThanOrEqual(6); expect(Math.abs((u.z >> 8) - 200)).toBeLessThanOrEqual(6) }
  })
  it('a far work task walks a route, claims only its final pose and gets done', () => {
    const sim = makeWide(256); spawn(sim, [5, 4, 5])
    cmd(sim, { type: 'workDig', min: [200, 3, 200], max: [200, 3, 200] })
    until(sim, () => sim.workers!.units.get(1)!.route !== null, 5)
    until(sim, () => sim.workers!.units.get(1)!.route?.last !== -1, 200)
    expect(sim.workers!.units.get(1)!.workPoses).toHaveLength(1)
    until(sim, () => sim.workers!.publication().orders[0]?.done === 1, 4000)
  })
  it('replays route and group commands with the same hashes', () => {
    const run = () => {
      const sim = makeWide(128), hashes: number[] = []
      for (let i = 0; i < 4; i++) spawn(sim, [4 + i * 2, 4, 4])
      cmd(sim, { type: 'unitMove', ids: [1, 2, 3], pos: [110, 4, 100] })
      cmd(sim, { type: 'unitMove', ids: [4], pos: [100, 4, 120] })
      for (let t = 0; t < 120; t++) { sim.step(); hashes.push(sim.hash()) }
      cmd(sim, { type: 'fillRegion', min: [60, 4, 0], max: [60, 7, 90], voxel: 1 })
      for (let t = 0; t < 200; t++) { sim.step(); hashes.push(sim.hash()) }
      return hashes
    }
    expect(run()).toEqual(run())
  })
})
