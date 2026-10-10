import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import type { Command } from '../src/sim/commands.ts'
import { staleBackoff } from '../src/sim/workers/workers.ts'
import type { WorkerOptions } from '../src/sim/workers/types.ts'
import type { GeneratorContext } from '../src/sim/generator.ts'

const blocks = [{ name: 'stone' }, { name: 'planks' }, { name: 'water', liquid: true }, { name: 'sand', falls: true }, { name: 'beam', collapses: true }]
function make(extra?: (ctx: GeneratorContext) => void, options: WorkerOptions = {}) {
  const sim = new Simulation({ buffers: createWorldBuffers([32, 32, 32]), blocks, seed: 1, randomTicksPerChunk: 0, workers: { materials: { stone: { digTicks: 4, buildTicks: 3 }, planks: { digTicks: 2, buildTicks: 3 } }, ...options } })
  sim.generate({ generateColumn(ctx) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) ctx.set(x, y, z, 1); extra?.(ctx) } })
  return sim
}
let seq = 0
function cmd(sim: Simulation, command: Command) { sim.submit(0, ++seq, command); const r = sim.step(); expect(r.acks[0]?.ok, r.acks[0]?.error).toBe(true); return r }
function spawn(sim: Simulation, pos = [5, 4, 5], stock: { block: number; count: number }[] = []) { cmd(sim, { type: 'unitSpawn', pos, stock }); return sim.workers!.units.size }
function until(sim: Simulation, predicate: () => boolean, cap = 500) { for (let i = 0; i < cap; i++) { if (predicate()) return; sim.step() }; expect(predicate(), JSON.stringify(sim.workers!.publication())).toBe(true) }

describe('simulated workers', () => {
  it('publishes the tick and one barrier per edit, over every chunk whose mesh the edit changes', () => {
    const sim = new Simulation({ buffers: createWorldBuffers([64, 64, 64]), blocks, seed: 1, randomTicksPerChunk: 0, workers: { materials: { stone: { digTicks: 4 } } } })
    sim.generate({ generateColumn(ctx, cx, cz) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) ctx.set(x, y, z, 1); if (cx === 0 && cz === 0) ctx.set(31, 4, 31, 1) } })
    spawn(sim, [28, 4, 28]); cmd(sim, { type: 'workDig', min: [31, 4, 31], max: [31, 4, 31] })
    const around = [sim.layout.chunkOf(31, 4, 31), sim.layout.chunkOf(32, 4, 31), sim.layout.chunkOf(31, 4, 32), sim.layout.chunkOf(32, 4, 32)].sort((a, b) => a - b)
    const before = around.map(ci => sim.store.versions[ci]!)
    let r = sim.step()
    for (let i = 0; i < 500 && !r.workers!.barriers.length; i++) r = sim.step()
    expect(sim.store.getVoxel(31, 4, 31)).toBe(0)
    expect(r.workers!.tick).toBe(r.tick)
    expect(r.workers!.barriers).toEqual([{ unit: 1, pos: [31, 4, 31], chunks: around.map(chunk => ({ chunk, version: sim.store.versions[chunk]! })) }])
    // Every chunk of the barrier moved its version, so a mesh from before the edit cannot release it.
    for (const [i, ci] of around.entries()) expect(sim.store.versions[ci]!).toBeGreaterThan(before[i]!)
    expect(sim.step().workers!.barriers).toEqual([])
  })
  it('keeps advancing every walking tick across intermediate waypoints', () => {
    const sim = make(); spawn(sim); cmd(sim, { type: 'unitMove', ids: [1], pos: [12, 4, 5] })
    until(sim, () => sim.workers!.view(1)?.state === 'walking')
    const distances: number[] = []
    for (let tick = 0; tick < 100; tick++) {
      const before = sim.workers!.view(1)!
      if (before.state === 'idle') break
      sim.step()
      const after = sim.workers!.view(1)!
      if (after.state === 'walking') distances.push(Math.hypot(after.x256 - before.x256, after.z256 - before.z256))
    }
    expect(sim.workers!.view(1)?.state).toBe('idle')
    expect(distances.length).toBeGreaterThan(10)
    expect(Math.min(...distances), `walking distances: ${distances.join(',')}`).toBeGreaterThan(0)
  })
  it('walks directly off the grid between visible destinations on an open floor', () => {
    const sim = make(); spawn(sim); cmd(sim, { type: 'unitMove', ids: [1], pos: [12, 4, 8] })
    let distance = 0, diagonalTicks = 0
    for (let tick = 0; tick < 100; tick++) {
      const before = sim.workers!.view(1)!
      if (before.state === 'idle') break
      sim.step()
      const after = sim.workers!.view(1)!, dx = after.x256 - before.x256, dz = after.z256 - before.z256
      distance += Math.hypot(dx, dz)
      if (dx && dz) diagonalTicks++
    }
    expect(sim.workers!.view(1)?.state).toBe('idle')
    expect(diagonalTicks).toBeGreaterThan(0)
    expect(distance / 256).toBeCloseTo(Math.hypot(7, 3), 1)
    expect(sim.workers!.view(1)).toMatchObject({ x256: 12 * 256 + 128, y256: 1024, z256: 8 * 256 + 128 })
  })
  it('normalizes diagonal speed and keeps intermediate walking poses off cell centers', () => {
    const sim = make(); spawn(sim); cmd(sim, { type: 'unitMove', ids: [1], pos: [12, 4, 8] })
    until(sim, () => sim.workers!.view(1)?.state === 'walking')
    const speeds: number[] = [], offGrid: number[] = []
    for (let tick = 0; tick < 100 && sim.workers!.view(1)?.state !== 'idle'; tick++) {
      const before = sim.workers!.view(1)!; sim.step(); const after = sim.workers!.view(1)!
      speeds.push(Math.hypot(after.x256 - before.x256, after.z256 - before.z256))
      if (after.x256 % 256 !== 128 && after.z256 % 256 !== 128) offGrid.push(tick)
    }
    expect(sim.workers!.view(1)?.state).toBe('idle')
    expect(offGrid.length).toBeGreaterThan(20)
    expect(Math.min(...speeds)).toBeGreaterThan(61)
    expect(Math.max(...speeds)).toBeLessThan(65)
  })
  it('keeps the whole body clear while smoothing a route around a tall wall', () => {
    const sim = make(ctx => { for (let z = 3; z <= 10; z++) for (let y = 4; y < 8; y++) ctx.set(8, y, z, 1) }); spawn(sim)
    cmd(sim, { type: 'unitMove', ids: [1], pos: [12, 4, 8] })
    for (let tick = 0; tick < 500 && sim.workers!.view(1)?.state !== 'idle'; tick++) {
      sim.step(); const u = sim.workers!.view(1)!
      for (let z = Math.floor((u.z256 - 96) / 256); z <= Math.floor((u.z256 + 95) / 256); z++)
        for (let x = Math.floor((u.x256 - 96) / 256); x <= Math.floor((u.x256 + 95) / 256); x++)
          for (let y = 4; y < 6; y++) expect(sim.store.getVoxel(x, y, z), `body at ${x},${y},${z}`).toBe(0)
    }
    expect(sim.workers!.view(1)).toMatchObject({ state: 'idle', x256: 12 * 256 + 128, z256: 8 * 256 + 128 })
  })
  it('follows a one-block-wide L floor without cutting the unsupported inside corner', () => {
    const sim = make(ctx => {
      for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) if (!(z === 5 && x >= 5 && x <= 12 || x === 12 && z >= 5 && z <= 12))
        for (let y = 0; y < 4; y++) ctx.set(x, y, z, 0)
    }); spawn(sim)
    cmd(sim, { type: 'unitMove', ids: [1], pos: [12, 4, 12] })
    for (let tick = 0; tick < 300 && sim.workers!.view(1)?.state !== 'idle'; tick++) {
      sim.step(); const u = sim.workers!.view(1)!
      expect(u.y256).toBe(1024)
      for (let z = Math.floor((u.z256 - 96) / 256); z <= Math.floor((u.z256 + 95) / 256); z++)
        for (let x = Math.floor((u.x256 - 96) / 256); x <= Math.floor((u.x256 + 95) / 256); x++) expect(sim.store.getVoxel(x, 3, z)).toBe(1)
    }
    expect(sim.workers!.view(1)).toMatchObject({ state: 'idle', x256: 12 * 256 + 128, z256: 12 * 256 + 128 })
  })
  it('stops a long flat shortcut immediately when cancelled and replans from that off-center pose', () => {
    const sim = make(); spawn(sim); cmd(sim, { type: 'unitMove', ids: [1], pos: [25, 4, 18] })
    until(sim, () => sim.workers!.view(1)?.state === 'walking'); sim.step(); sim.step()
    const before = sim.workers!.view(1)!
    cmd(sim, { type: 'unitCancel', ids: [1] })
    expect(sim.workers!.view(1)).toMatchObject({ state: 'idle', available: false, x256: before.x256, z256: before.z256 })
    for (let tick = 0; tick < 10; tick++) sim.step()
    expect(sim.workers!.view(1)?.x256).toBe(before.x256)
    cmd(sim, { type: 'unitMove', ids: [1], pos: [4, 4, 9] })
    until(sim, () => sim.workers!.view(1)?.state === 'idle')
    expect(sim.workers!.view(1)).toMatchObject({ x256: 4 * 256 + 128, z256: 9 * 256 + 128 })
  })
  it('reserves only the next flat sweep and stops before a newly inserted wall farther along the shortcut', () => {
    const sim = make(); spawn(sim); cmd(sim, { type: 'unitMove', ids: [1], pos: [25, 4, 5] })
    until(sim, () => sim.workers!.view(1)?.state === 'walking')
    cmd(sim, { type: 'fillRegion', min: [10, 4, 5], max: [10, 7, 5], voxel: 1 })
    until(sim, () => sim.workers!.view(1)?.state === 'blocked')
    expect(sim.workers!.view(1)!.x256 + 95).toBeLessThan(10 * 256)
    expect(sim.workers!.view(1)?.state).not.toBe('incapacitated')
    cmd(sim, { type: 'fillRegion', min: [10, 4, 5], max: [10, 7, 5], voxel: 0 })
    until(sim, () => sim.workers!.view(1)?.state === 'idle')
    expect(sim.workers!.view(1)?.x256).toBe(25 * 256 + 128)
  })
  it('centers a destination in the current cell after stopping off the grid', () => {
    const sim = make(); spawn(sim); cmd(sim, { type: 'unitMove', ids: [1], pos: [12, 4, 8] })
    until(sim, () => sim.workers!.view(1)?.state === 'walking'); sim.step()
    cmd(sim, { type: 'unitCancel', ids: [1] })
    const u = sim.workers!.view(1)!, x = u.x256 >> 8, z = u.z256 >> 8
    expect(u.x256 % 256).not.toBe(128)
    cmd(sim, { type: 'unitMove', ids: [1], pos: [x, 4, z] })
    until(sim, () => sim.workers!.view(1)?.state === 'idle')
    expect(sim.workers!.view(1)).toMatchObject({ x256: x * 256 + 128, z256: z * 256 + 128 })
  })
  it('retries an inaccessible dig after cancelling build designations that reserved every work pose', () => {
    const sim = make(ctx => ctx.set(6, 4, 5, 1)); spawn(sim, [3, 4, 5])
    for (const [x, z] of [[5, 5], [7, 5], [6, 4], [6, 6]]) cmd(sim, { type: 'workBuild', min: [x!, 4, z!], max: [x!, 5, z!], voxel: 2 })
    cmd(sim, { type: 'workDig', min: [6, 4, 5], max: [6, 4, 5] })
    until(sim, () => sim.workers!.publication().orders[4]?.reason === 'no-access')
    for (let order = 1; order <= 4; order++) cmd(sim, { type: 'workCancel', order })
    until(sim, () => sim.store.getVoxel(6, 4, 5) === 0)
    expect(sim.workers!.view(1)?.stock).toEqual([{ block: 1, count: 1 }])
  })
  it.each(['material', 'tool'] as const)('does not retain a unit-by-task failure cache for missing %s', kind => {
    const sim = make(ctx => { if (kind === 'tool') for (let x = 24; x <= 27; x++) for (let z = 24; z <= 27; z++) ctx.set(x, 4, z, 1) },
      { materials: { stone: { digTicks: 4, buildTicks: 3, tool: 'pick' }, planks: { digTicks: 2, buildTicks: 3 } } })
    for (let i = 0; i < 64; i++) spawn(sim, [2 + i % 8 * 3, 4, 2 + Math.floor(i / 8) * 3])
    cmd(sim, kind === 'material' ? { type: 'workBuild', min: [24, 4, 24], max: [27, 4, 27], voxel: 2 } : { type: 'workDig', min: [24, 4, 24], max: [27, 4, 27] })
    for (let i = 0; i < 12; i++) sim.step()
    const tasks = (sim.workers as unknown as { tasks: { failures: Map<number, unknown> }[] }).tasks
    // A build exposes only its innermost ring (2×2 here); a dig exposes the whole layer.
    expect(tasks).toHaveLength(kind === 'material' ? 4 : 16)
    expect(tasks.reduce((n, t) => n + t.failures.size, 0)).toBe(0)
    expect(sim.workers!.publication().orders[0]?.reason).toBe(kind === 'material' ? 'missing-material' : 'missing-tool')
    if (kind === 'material') cmd(sim, { type: 'unitStock', ids: [64], block: 2, count: 1 })
    else cmd(sim, { type: 'unitSpawn', pos: [23, 4, 24], tools: ['pick'] })
    until(sim, () => kind === 'material' ? sim.workers!.publication().orders[0]!.done === 1 : sim.store.getVoxel(24, 4, 24) === 0)
    expect(sim.workers!.view(kind === 'material' ? 64 : 65)?.stock).toEqual([{ block: kind === 'material' ? 2 : 1, count: kind === 'material' ? 0 : 1 }])
  })
  it.each(['material', 'tool'] as const)('does not let eight tasks missing a %s hide an executable ninth task', kind => {
    const sim = make(ctx => { if (kind === 'tool') { for (let x = 6; x <= 13; x++) ctx.set(x, 4, 5, 1); ctx.set(20, 4, 5, 2) } },
      { materials: { stone: { digTicks: 4, buildTicks: 3, tool: 'pick' }, planks: { digTicks: 2, buildTicks: 3 } } })
    spawn(sim, [5, 4, 5], kind === 'material' ? [{ block: 2, count: 1 }] : [])
    for (let x = 6; x <= 13; x++) cmd(sim, kind === 'material' ? { type: 'workBuild', min: [x, 4, 5], max: [x, 4, 5], voxel: 1 } : { type: 'workDig', min: [x, 4, 5], max: [x, 4, 5] })
    cmd(sim, kind === 'material' ? { type: 'workBuild', min: [20, 4, 5], max: [20, 4, 5], voxel: 2 } : { type: 'workDig', min: [20, 4, 5], max: [20, 4, 5] })
    until(sim, () => sim.store.getVoxel(20, 4, 5) === (kind === 'material' ? 2 : 0))
    expect(sim.workers!.publication().orders.filter(o => o.done === 1)).toHaveLength(1)
    expect(sim.workers!.view(1)?.stock).toEqual([{ block: 2, count: kind === 'material' ? 0 : 1 }])
  })
  it.each([false, true])('allows a newly spawned reachable worker after another cannot reach a task (stop first: %s)', stop => {
    const sim = make(ctx => { for (let z = 0; z < 32; z++) for (let y = 4; y <= 15; y++) ctx.set(10, y, z, 1); ctx.set(20, 4, 5, 1) })
    spawn(sim); cmd(sim, { type: 'workDig', min: [20, 4, 5], max: [20, 4, 5] })
    until(sim, () => sim.workers!.publication().orders[0]?.reason === 'no-access')
    spawn(sim, [19, 4, 5]); if (stop) cmd(sim, { type: 'unitCancel', ids: [1] })
    until(sim, () => sim.store.getVoxel(20, 4, 5) === 0)
    expect(sim.workers!.view(1)?.stock).toEqual([])
    expect(sim.workers!.view(2)?.stock).toEqual([{ block: 1, count: 1 }])
  })
  it.each(['up', 'down'] as const)('falls when source support disappears before a %s transition', direction => {
    const sim = make(ctx => ctx.set(6, 4, 5, 1)); spawn(sim, direction === 'up' ? [5, 4, 5] : [6, 5, 5])
    cmd(sim, { type: 'unitMove', ids: [1], pos: direction === 'up' ? [6, 5, 5] : [5, 4, 5] })
    until(sim, () => sim.workers!.view(1)?.state === 'walking')
    const before = sim.workers!.view(1)!
    cmd(sim, { type: 'setBlock', pos: direction === 'up' ? [5, 3, 5] : [6, 4, 5], voxel: 0 })
    expect(sim.workers!.view(1)?.state).toBe('falling')
    expect(sim.workers!.view(1)!.y256).toBeLessThan(before.y256)
  })
  it('keeps ascent source support valid during its vertical phase, without cancelling a normal ascent', () => {
    for (const remove of [false, true]) {
      const sim = make(ctx => ctx.set(6, 4, 5, 1)); spawn(sim)
      cmd(sim, { type: 'unitMove', ids: [1], pos: [6, 5, 5] }); until(sim, () => sim.workers!.view(1)?.state === 'walking')
      sim.step(); expect(sim.workers!.view(1)!.y256).toBeGreaterThan(1024)
      if (remove) { const y = sim.workers!.view(1)!.y256; cmd(sim, { type: 'setBlock', pos: [5, 3, 5], voxel: 0 }); expect(sim.workers!.view(1)?.state).toBe('falling'); expect(sim.workers!.view(1)!.y256).toBeLessThan(y) }
      else { until(sim, () => sim.workers!.view(1)?.state === 'idle'); expect(sim.workers!.view(1)?.y256).toBe(1280) }
    }
  })
  it('reports a limited global search even after a spatially bounded engineering fallback exhausts its heap', () => {
    const sim = make(ctx => { for (let z = 4; z <= 20; z++) for (let y = 4; y <= 7; y++) ctx.set(13, y, z, 1) },
      { maxSearchNodes: 4, materials: { stone: { digTicks: 4, tool: 'pick' } } })
    spawn(sim, [12, 4, 12]); cmd(sim, { type: 'unitMove', ids: [1], pos: [14, 4, 12], allowDig: true })
    until(sim, () => sim.workers!.view(1)?.state === 'blocked')
    expect(sim.workers!.view(1)?.reason).toBe('search-limited')
  })
  it('preserves the global node limit when the local fallback exhausts an enclosed component', () => {
    const sim = make(ctx => {
      for (let x = 10; x <= 14; x++) for (let z = 10; z <= 14; z++) if (x === 10 || x === 14 || z === 10 || z === 14) for (let y = 4; y < 8; y++) ctx.set(x, y, z, 1)
    }, { maxSearchNodes: 4, materials: { stone: { digTicks: 4, tool: 'pick' } } })
    spawn(sim, [12, 4, 12]); cmd(sim, { type: 'unitMove', ids: [1], pos: [16, 4, 12], allowDig: true })
    until(sim, () => sim.workers!.view(1)?.state === 'blocked')
    expect(sim.workers!.view(1)?.reason).toBe('search-limited')
  })
  it('hashes blocked reasons and alternative paths that change future execution', () => {
    const sim = make(); spawn(sim); const u = sim.workers!.units.get(1)!
    u.state = 'blocked'; u.reason = 'no-access'; const before = sim.hash()
    u.reason = 'traffic'; expect(sim.hash()).not.toBe(before)
    const traffic = sim.hash(); u.alternative = [sim.layout.voxelIndex(6, 4, 5)]; expect(sim.hash()).not.toBe(traffic)
  })
  it('hashes synthetic engineering tasks and their order material', () => {
    const sim = make(ctx => { for (let z = 0; z < 32; z++) for (let y = 4; y < 8; y++) ctx.set(8, y, z, 1) }); spawn(sim)
    cmd(sim, { type: 'unitMove', ids: [1], pos: [11, 4, 5], allowDig: true }); until(sim, () => sim.workers!.view(1)?.state === 'working')
    const task = sim.workers!.units.get(1)!.task!, before = sim.hash()
    expect(task.order.id).toBeLessThan(0)
    task.expected++; expect(sim.hash()).not.toBe(before); task.expected--
    task.order.voxel++; expect(sim.hash()).not.toBe(before)
  })
  it('hashes per-worker access failures and removes a despawned worker from that cache', () => {
    const sim = make(ctx => { for (let z = 0; z < 32; z++) for (let y = 4; y <= 15; y++) ctx.set(10, y, z, 1); ctx.set(20, 4, 5, 1) })
    spawn(sim); cmd(sim, { type: 'workDig', min: [20, 4, 5], max: [20, 4, 5] }); until(sim, () => sim.workers!.publication().orders[0]?.reason === 'no-access')
    // This cache controls whether an idle worker may attempt the order again.
    const tasks = (sim.workers as unknown as { tasks: { failures: Map<number, { origin: number; policy: number; reason: string }> }[] }).tasks
    const failure = tasks[0]!.failures.get(1)!, before = sim.hash()
    failure.origin++; expect(sim.hash()).not.toBe(before); failure.origin--
    failure.policy++; expect(sim.hash()).not.toBe(before); failure.policy--
    failure.reason = 'traffic'; expect(sim.hash()).not.toBe(before); failure.reason = 'no-access'
    cmd(sim, { type: 'unitDespawn', ids: [1] }); expect(tasks[0]!.failures.size).toBe(0)
  })
  it('delimits variable path and work-pose arrays in the worker hash', () => {
    const sim = make(); spawn(sim); const u = sim.workers!.units.get(1)!, p = sim.layout.voxelIndex(6, 4, 5), q = sim.layout.voxelIndex(7, 4, 5)
    u.path = [p]; u.workPoses = [q]; const before = sim.hash()
    u.path = [p, q]; u.workPoses = []; expect(sim.hash()).not.toBe(before)
  })
  it('walks with Q8 poses and stops at the supported destination', () => {
    const sim = make(); spawn(sim); cmd(sim, { type: 'unitMove', ids: [1], pos: [12, 4, 8] })
    until(sim, () => sim.workers!.view(1)?.state === 'idle')
    expect(sim.workers!.view(1)).toMatchObject({ x256: 12 * 256 + 128, y256: 1024, z256: 8 * 256 + 128 })
  })
  it('digs only after arriving and collecting the drop once', () => {
    const sim = make(ctx => ctx.set(12, 4, 5, 1)); spawn(sim)
    cmd(sim, { type: 'workDig', min: [12, 4, 5], max: [12, 4, 5] })
    expect(sim.store.getVoxel(12, 4, 5)).toBe(1)
    until(sim, () => sim.store.getVoxel(12, 4, 5) === 0)
    expect(sim.workers!.view(1)?.stock).toEqual([{ block: 1, count: 1 }])
    for (let i = 0; i < 20; i++) sim.step()
    expect(sim.workers!.view(1)?.stock).toEqual([{ block: 1, count: 1 }])
  })
  it('builds a blueprint and consumes exactly its materials', () => {
    const sim = make(); spawn(sim, [5, 4, 5], [{ block: 2, count: 8 }])
    cmd(sim, { type: 'workBuild', min: [9, 4, 5], max: [11, 4, 5], voxel: 2 })
    until(sim, () => sim.workers!.publication().orders[0]?.done === 3)
    expect([9, 10, 11].map(x => sim.store.getVoxel(x, 4, 5))).toEqual([2, 2, 2])
    expect(sim.workers!.view(1)?.stock).toEqual([{ block: 2, count: 5 }])
  })
  it('waits for material and wakes when supplied', () => {
    const sim = make(); spawn(sim)
    cmd(sim, { type: 'workBuild', min: [8, 4, 5], max: [8, 4, 5], voxel: 2 })
    expect(sim.workers!.publication().orders[0]?.reason).toBe('missing-material')
    cmd(sim, { type: 'unitStock', ids: [1], block: 2, count: 1 })
    until(sim, () => sim.store.getVoxel(8, 4, 5) === 2)
    expect(sim.workers!.view(1)?.stock).toEqual([{ block: 2, count: 0 }])
  })
  it('does not duplicate work claimed by two units', () => {
    const sim = make(ctx => ctx.set(8, 4, 5, 1)); spawn(sim); spawn(sim, [5, 4, 7])
    cmd(sim, { type: 'workDig', min: [8, 4, 5], max: [8, 4, 5] })
    until(sim, () => sim.store.getVoxel(8, 4, 5) === 0)
    const drops = [1, 2].flatMap(id => sim.workers!.view(id)!.stock).reduce((n, item) => n + item.count, 0)
    expect(drops).toBe(1)
  })
  it('pauses movement and work and supports cancellation', () => {
    const sim = make(ctx => ctx.set(8, 4, 5, 1)); spawn(sim)
    cmd(sim, { type: 'workDig', min: [8, 4, 5], max: [8, 4, 5] })
    sim.setPaused(true); const before = sim.workers!.view(1)
    for (let i = 0; i < 40; i++) sim.step()
    expect(sim.workers!.view(1)).toEqual(before)
    cmd(sim, { type: 'workCancel', order: 1 }); sim.setPaused(false)
    for (let i = 0; i < 40; i++) sim.step()
    expect(sim.store.getVoxel(8, 4, 5)).toBe(1)
  })
  it('rejects an atomic fill through a body without partial edits', () => {
    const sim = make(); spawn(sim)
    sim.submit(0, ++seq, { type: 'fillRegion', min: [4, 4, 5], max: [6, 5, 5], voxel: 1 })
    expect(sim.step().acks[0]?.ok).toBe(false); expect(sim.store.getVoxel(4, 4, 5)).toBe(0)
  })
  it('falls when its floor is removed', () => {
    const sim = make(); spawn(sim)
    cmd(sim, { type: 'setBlock', pos: [5, 3, 5], voxel: 0 })
    until(sim, () => sim.workers!.view(1)?.y256 === 3 * 256)
    expect(sim.workers!.view(1)?.state).toBe('idle')
  })
  it('bounds search work and reports limits explicitly', () => {
    const sim = make(undefined, { searchCap: 8, maxSearchNodes: 4 }); spawn(sim)
    cmd(sim, { type: 'unitMove', ids: [1], pos: [25, 4, 25] })
    for (let i = 0; i < 20; i++) expect(sim.step().workers!.stats.visited).toBeLessThanOrEqual(8)
    expect(sim.workers!.view(1)?.reason).toBe('search-limited')
  })
  it('keeps multiple units from occupying the same volume during movement', () => {
    const sim = make(); spawn(sim); spawn(sim, [12, 4, 5])
    cmd(sim, { type: 'unitMove', ids: [1], pos: [12, 4, 5] }); cmd(sim, { type: 'unitMove', ids: [2], pos: [5, 4, 5] })
    for (let i = 0; i < 180; i++) {
      sim.step(); const a = sim.workers!.view(1)!, b = sim.workers!.view(2)!
      expect(Math.abs(a.x256 - b.x256) >= 192 || Math.abs(a.z256 - b.z256) >= 192).toBe(true)
    }
    expect(sim.workers!.view(1)?.state).toBe('idle'); expect(sim.workers!.view(2)?.state, JSON.stringify(sim.workers!.view(2))).toBe('idle')
  })
  it('replays worker commands with the same hashes', () => {
    const a = make(ctx => ctx.set(8, 4, 5, 1)), b = make(ctx => ctx.set(8, 4, 5, 1))
    const commands: Command[] = [{ type: 'unitSpawn', pos: [5, 4, 5] }, { type: 'workDig', min: [8, 4, 5], max: [8, 4, 5] }]
    for (let tick = 0; tick < 80; tick++) {
      if (commands[tick]) { a.submit(0, tick, commands[tick]!); b.submit(0, tick, commands[tick]!) }
      a.step(); b.step(); expect(a.hash()).toBe(b.hash())
    }
  })
  it('automatically digs a bounded passage when the move policy allows it', () => {
    const sim = make(ctx => { for (let z = 0; z < 32; z++) for (let y = 4; y < 8; y++) ctx.set(8, y, z, 1) }); spawn(sim)
    cmd(sim, { type: 'unitMove', ids: [1], pos: [11, 4, 5], allowDig: true })
    until(sim, () => sim.workers!.view(1)?.state === 'idle', 1200)
    expect(sim.workers!.view(1)?.x256).toBe(11 * 256 + 128)
    expect(sim.store.getVoxel(8, 4, 5)).toBe(0); expect(sim.store.getVoxel(8, 5, 5)).toBe(0)
    expect(sim.workers!.view(1)?.stock).toEqual([{ block: 1, count: 2 }])
  })
  it('automatically bridges two missing supports without inventing materials', () => {
    const sim = make(ctx => { for (let z = 0; z < 32; z++) for (let x = 8; x <= 9; x++) for (let y = 0; y < 4; y++) ctx.set(x, y, z, 0) }); spawn(sim, [5, 4, 5], [{ block: 2, count: 2 }])
    cmd(sim, { type: 'unitMove', ids: [1], pos: [11, 4, 5], buildBlock: 2 })
    until(sim, () => sim.workers!.view(1)?.state === 'idle', 1200)
    expect(sim.workers!.view(1)?.x256).toBe(11 * 256 + 128)
    expect(sim.workers!.view(1)?.stock).toEqual([{ block: 2, count: 0 }])
    expect(sim.store.getVoxel(8, 3, 5)).toBe(2); expect(sim.store.getVoxel(9, 3, 5)).toBe(2)
  })
  it('keeps drops when inventory is full', () => {
    const sim = make(ctx => ctx.set(8, 4, 5, 1), { inventoryCapacity: 1 }); spawn(sim, [5, 4, 5], [{ block: 2, count: 1 }])
    cmd(sim, { type: 'workDig', min: [8, 4, 5], max: [8, 4, 5] })
    until(sim, () => sim.store.getVoxel(8, 4, 5) === 0)
    expect(sim.workers!.viewDrops()).toEqual([{ pos: [8, 4, 5], block: 1, count: 1 }])
    expect(sim.workers!.view(1)?.stock).toEqual([{ block: 2, count: 1 }])
  })
  it('does not collect a second drop when the player removes the work target first', () => {
    const sim = make(ctx => ctx.set(6, 4, 5, 1)); spawn(sim)
    cmd(sim, { type: 'workDig', min: [6, 4, 5], max: [6, 4, 5] })
    until(sim, () => sim.workers!.view(1)?.state === 'working')
    cmd(sim, { type: 'setBlock', pos: [6, 4, 5], voxel: 0 }); for (let i = 0; i < 12; i++) sim.step()
    expect(sim.workers!.view(1)?.stock).toEqual([]); expect(sim.workers!.publication().orders[0]?.done).toBe(1)
  })
  it('uses a capable worker even if the first one lacks a tool', () => {
    const sim = make(ctx => ctx.set(8, 4, 5, 1), { materials: { stone: { digTicks: 3, tool: 'pick' } } }); spawn(sim)
    cmd(sim, { type: 'unitSpawn', pos: [5, 4, 7], tools: ['pick'] })
    cmd(sim, { type: 'workDig', min: [8, 4, 5], max: [8, 4, 5] })
    until(sim, () => sim.store.getVoxel(8, 4, 5) === 0)
    expect(sim.workers!.view(2)?.stock).toEqual([{ block: 1, count: 1 }])
  })
  it('rejects invalid commands before changing stock or spawning', () => {
    const sim = make(); spawn(sim)
    for (const c of [{ type: 'unitStock', ids: [1, 99], block: 2, count: 5 }, { type: 'unitSpawn', pos: [5, 4, 5] }, { type: 'workBuild', min: [6, 4, 5], max: [5, 4, 5], voxel: 2 }]) {
      sim.submit(0, ++seq, c); expect(sim.step().acks[0]?.ok).toBe(false)
    }
    expect(sim.workers!.units.size).toBe(1); expect(sim.workers!.view(1)?.stock).toEqual([])
  })
  it('does not invalidate geometry when only light changes', () => {
    const sim = make(); spawn(sim); const rev = sim.workers!.nav.revision
    sim.store.setLight(5, 4, 5, 1); sim.store.commit(); sim.step()
    expect(sim.workers!.nav.revision).toBe(rev)
  })
  it('builds a two-layer wall without stranding builders on top of it', () => {
    const sim = make(); spawn(sim, [5, 4, 5], [{ block: 2, count: 10 }]); spawn(sim, [5, 4, 7], [{ block: 2, count: 10 }])
    cmd(sim, { type: 'workBuild', min: [8, 4, 5], max: [12, 5, 5], voxel: 2 })
    until(sim, () => sim.workers!.publication().orders[0]?.done === 10, 1200)
  })
  it('rejects water immersion on the cave floor but admits the dry roof', () => {
    const sim = make(ctx => {
      for (let x = 7; x <= 9; x++) for (let z = 4; z <= 6; z++) for (let y = 4; y <= 6; y++) ctx.set(x, y, z, x === 8 && z === 5 && y < 6 ? 3 | (7 << 12) : 1)
    })
    expect(sim.water.depthAt(8, 4, 5)).toBeGreaterThan(128); expect(sim.water.depthAt(8, 7, 5)).toBe(0)
    sim.submit(0, ++seq, { type: 'unitSpawn', pos: [8, 4, 5] }); expect(sim.step().acks[0]?.ok).toBe(false)
    spawn(sim, [8, 7, 5]); expect(sim.workers!.view(1)?.y256).toBe(7 * 256)
  })
  it('records a falling block sweep and incapacitates the unit it crosses', () => {
    const sim = make(); spawn(sim)
    cmd(sim, { type: 'setBlock', pos: [5, 12, 5], voxel: 4 })
    until(sim, () => sim.workers!.view(1)?.state === 'incapacitated')
    expect(sim.workers!.overlaps(5, 4, 5)).toBe(false)
  })
  it('rejects regeneration through a unit before changing any voxels', () => {
    const sim = make(); spawn(sim)
    const data = sim.store.readVoxels(0, new Uint16Array(32768)).slice(); data[5 + (5 << 5) + (4 << 10)] = 1
    expect(() => sim.replaceColumns([{ cx: 0, cz: 0, data }])).toThrow('regeneration overlaps a unit')
    expect(sim.store.getVoxel(5, 4, 5)).toBe(0)
  })
  it('does not spend a partial bridge when the constrained plan lacks material', () => {
    const sim = make(ctx => {
      for (let z = 0; z < 32; z++) for (let x = 8; x <= 9; x++) for (let y = 0; y < 4; y++) ctx.set(x, y, z, 0)
      for (let x = 0; x < 32; x++) for (const z of [4, 6]) for (let y = 4; y < 8; y++) ctx.set(x, y, z, 1)
    }); spawn(sim, [5, 4, 5], [{ block: 2, count: 1 }])
    cmd(sim, { type: 'unitMove', ids: [1], pos: [11, 4, 5], buildBlock: 2 })
    until(sim, () => sim.workers!.view(1)?.state === 'blocked')
    expect(sim.workers!.view(1)?.reason).toBe('missing-material')
    expect(sim.workers!.view(1)?.stock).toEqual([{ block: 2, count: 1 }]); expect(sim.store.getVoxel(8, 3, 5)).toBe(0)
  })
  it('releases engineering claims on cancellation', () => {
    const sim = make(ctx => { for (let z = 0; z < 32; z++) for (let y = 4; y < 8; y++) ctx.set(8, y, z, 1) }); spawn(sim)
    cmd(sim, { type: 'unitMove', ids: [1], pos: [11, 4, 5], allowDig: true })
    until(sim, () => sim.workers!.view(1)?.state === 'working')
    cmd(sim, { type: 'unitCancel', ids: [1] }); expect(sim.store.getVoxel(8, 4, 5)).toBe(1)
    cmd(sim, { type: 'workDig', min: [8, 4, 5], max: [8, 4, 5] })
    until(sim, () => sim.store.getVoxel(8, 4, 5) === 0)
  })
  it('replans work after a target changes to another permitted material', () => {
    const sim = make(ctx => ctx.set(6, 4, 5, 1)); spawn(sim)
    cmd(sim, { type: 'workDig', min: [6, 4, 5], max: [6, 4, 5] })
    until(sim, () => sim.workers!.view(1)?.state === 'working')
    cmd(sim, { type: 'setBlock', pos: [6, 4, 5], voxel: 2 })
    until(sim, () => sim.store.getVoxel(6, 4, 5) === 0)
    expect(sim.workers!.view(1)?.stock).toEqual([{ block: 2, count: 1 }])
  })
  it('falls if the source floor disappears before a walking step advances', () => {
    const sim = make(); spawn(sim)
    cmd(sim, { type: 'unitMove', ids: [1], pos: [12, 4, 5] })
    until(sim, () => sim.workers!.view(1)?.state === 'walking')
    cmd(sim, { type: 'setBlock', pos: [5, 3, 5], voxel: 0 })
    expect(sim.workers!.view(1)?.state).toBe('falling')
    until(sim, () => sim.workers!.view(1)?.state === 'idle')
    expect(sim.workers!.view(1)?.x256).toBe(12 * 256 + 128)
  })
  it('leaves gaps in group destinations so earlier arrivals do not encircle the final unit', () => {
    const sim = make()
    for (let i = 0; i < 8; i++) spawn(sim, [4 + i % 4 * 2, 4, 4 + Math.floor(i / 4) * 2])
    cmd(sim, { type: 'unitMove', ids: [...sim.workers!.units.keys()], pos: [20, 4, 18] })
    until(sim, () => [...sim.workers!.units.values()].every(u => u.state === 'idle'), 1500)
    expect(new Set([...sim.workers!.units.values()].map(u => `${u.x}:${u.z}`)).size).toBe(8)
  })
  it('keeps a stopped worker from immediately reclaiming the cancelled assignment', () => {
    const sim = make(ctx => ctx.set(6, 4, 5, 1)); spawn(sim)
    cmd(sim, { type: 'workDig', min: [6, 4, 5], max: [6, 4, 5] })
    until(sim, () => sim.workers!.view(1)?.state === 'working')
    cmd(sim, { type: 'unitCancel', ids: [1] }); for (let i = 0; i < 20; i++) sim.step()
    expect(sim.store.getVoxel(6, 4, 5)).toBe(1); expect(sim.workers!.view(1)).toMatchObject({ state: 'idle', available: false })
  })
  it('digs a designation larger than the frontier from the top layer down', () => {
    const sim = make(); spawn(sim, [2, 4, 2])
    cmd(sim, { type: 'workDig', min: [8, 2, 8], max: [23, 3, 23] })
    until(sim, () => sim.workers!.publication().orders[0]!.done >= 4, 600)
  })
  it('rotates unreachable tasks out of a full frontier so reachable cells behind them get dug', () => {
    const sim = make(ctx => {
      for (let x = 8; x <= 27; x++) for (let z = 8; z <= 22; z++) ctx.set(x, 4, z, 1)
      // Seal rows z=8..20 (260 cells): roof over them and walls around, so no work pose reaches them.
      for (let x = 8; x <= 27; x++) for (let z = 8; z <= 20; z++) for (let y = 5; y <= 6; y++) ctx.set(x, y, z, 1)
      for (let z = 7; z <= 21; z++) for (let y = 4; y <= 6; y++) { ctx.set(7, y, z, 1); ctx.set(28, y, z, 1) }
      for (let x = 7; x <= 28; x++) for (let y = 4; y <= 6; y++) ctx.set(x, y, 7, 1)
    })
    spawn(sim, [2, 4, 26])
    cmd(sim, { type: 'workDig', min: [8, 4, 8], max: [27, 4, 22] })
    until(sim, () => sim.store.getVoxel(8, 4, 22) === 0 || sim.store.getVoxel(27, 4, 22) === 0, 1500)
  })
  it('walks out of a build designation that covers its own pose', () => {
    const sim = make(); spawn(sim, [4, 4, 5])
    cmd(sim, { type: 'workBuild', min: [4, 4, 4], max: [6, 4, 6], voxel: 2 })
    cmd(sim, { type: 'unitMove', ids: [1], pos: [0, 4, 5] })
    until(sim, () => sim.workers!.view(1)?.state === 'idle' && sim.workers!.view(1)!.x256 === 128, 300)
  })
  it('evacuates an idle occupant so the cell under it gets built', () => {
    const sim = make(); spawn(sim, [5, 4, 5]); spawn(sim, [2, 4, 5], [{ block: 2, count: 32 }])
    cmd(sim, { type: 'workBuild', min: [4, 4, 4], max: [6, 4, 6], voxel: 2 })
    until(sim, () => sim.workers!.publication().orders[0]?.done === 9, 1200)
  })
  it('does not livelock two separate move orders sent to the same destination', () => {
    const sim = make(); spawn(sim, [5, 4, 5]); spawn(sim, [5, 4, 9])
    cmd(sim, { type: 'unitMove', ids: [1], pos: [12, 4, 7] }); cmd(sim, { type: 'unitMove', ids: [2], pos: [12, 4, 7] })
    until(sim, () => [1, 2].every(id => sim.workers!.view(id)?.state === 'idle'), 600)
    const [a, b] = [1, 2].map(id => sim.workers!.view(id)!)
    expect(a.x256 !== b!.x256 || a.z256 !== b!.z256).toBe(true)
  })
  it('takes a nearby pose when a stopped unit is parked on its destination', () => {
    const sim = make(); spawn(sim, [5, 4, 5]); spawn(sim, [5, 4, 9])
    cmd(sim, { type: 'unitMove', ids: [1], pos: [15, 4, 5] }); cmd(sim, { type: 'unitMove', ids: [2], pos: [10, 4, 5] })
    until(sim, () => sim.workers!.view(1)!.x256 >> 8 === 10)
    cmd(sim, { type: 'unitCancel', ids: [1] })
    until(sim, () => sim.workers!.view(2)?.state === 'idle', 600)
  })
  it('does not replan a blocked move every tick just because another unit is walking', () => {
    const sim = make(ctx => { for (let z = 0; z < 32; z++) for (let y = 4; y <= 15; y++) ctx.set(10, y, z, 1) })
    spawn(sim); spawn(sim, [2, 4, 2])
    cmd(sim, { type: 'unitMove', ids: [1], pos: [20, 4, 5] })
    until(sim, () => sim.workers!.view(1)?.reason === 'no-access')
    const nav = sim.workers!.nav, request = nav.request.bind(nav)
    let requests = 0
    nav.request = (...args) => { requests++; return request(...args) }
    cmd(sim, { type: 'unitMove', ids: [2], pos: [2, 4, 28] })
    let blocked = 0
    for (let i = 0; i < 100; i++) { sim.step(); if (sim.workers!.view(1)?.reason === 'no-access') blocked++ }
    expect(requests).toBeLessThanOrEqual(6)
    expect(blocked).toBeGreaterThan(90)
  })
  it('finishes a sliced search while unrelated far-away edits keep happening', () => {
    const sim = make(undefined, { searchCap: 16 }); spawn(sim, [2, 4, 5])
    cmd(sim, { type: 'unitMove', ids: [1], pos: [28, 4, 5] })
    for (let i = 0; i < 400 && sim.workers!.view(1)?.state !== 'idle'; i++) cmd(sim, { type: 'setBlock', pos: [20, 8, 24], voxel: i & 1 })
    expect(sim.workers!.view(1)).toMatchObject({ state: 'idle', x256: 28 * 256 + 128 })
  })
  it('backs off instead of restarting a repeatedly stale search every tick', () => {
    const sim = make(undefined, { searchCap: 16 }); spawn(sim, [2, 4, 5])
    const nav = sim.workers!.nav, request = nav.request.bind(nav)
    let requests = 0
    nav.request = (...args) => { requests++; return request(...args) }
    cmd(sim, { type: 'unitMove', ids: [1], pos: [28, 4, 5] })
    for (let i = 0; i < 200; i++) cmd(sim, { type: 'setBlock', pos: [3, 8, 5], voxel: i & 1 })
    expect(requests).toBeLessThan(12)
  })
  it('keeps searches that never explored a new build designation', () => {
    const sim = make(undefined, { searchCap: 16 }); spawn(sim, [2, 4, 5])
    cmd(sim, { type: 'unitMove', ids: [1], pos: [28, 4, 5] })
    const search = sim.workers!.units.get(1)!.search!
    expect(search.status).toBe('pending')
    cmd(sim, { type: 'workBuild', min: [20, 4, 24], max: [22, 4, 26], voxel: 2 })
    expect(search.status).not.toBe('cancelled')
  })
  it('cancels a found path that crosses a new build designation', () => {
    const sim = make(); spawn(sim, [2, 4, 5])
    cmd(sim, { type: 'unitMove', ids: [1], pos: [28, 4, 5] })
    cmd(sim, { type: 'workBuild', min: [14, 4, 0], max: [14, 5, 31], voxel: 2 })
    until(sim, () => sim.workers!.view(1)?.state === 'blocked' || sim.workers!.view(1)?.state === 'idle')
    expect(sim.workers!.view(1)!.x256 >> 8).toBeLessThan(14)
  })
  it('drops the walking alternative once it adopts an engineering plan', () => {
    const sim = make(ctx => { for (let z = 0; z <= 20; z++) for (let y = 4; y < 8; y++) ctx.set(8, y, z, 1) }); spawn(sim)
    cmd(sim, { type: 'unitMove', ids: [1], pos: [11, 4, 5], allowDig: true })
    until(sim, () => sim.workers!.view(1)?.state === 'working', 600)
    expect(sim.workers!.units.get(1)!.alternative).toEqual([])
  })
  it('drops a stale walking alternative when it falls', () => {
    const sim = make(); spawn(sim); const u = sim.workers!.units.get(1)!
    u.alternative = [sim.layout.voxelIndex(6, 4, 5)]; u.alternativeCost = 4
    cmd(sim, { type: 'setBlock', pos: [5, 3, 5], voxel: 0 })
    expect(u.state).toBe('falling'); expect(u.alternative).toEqual([])
  })
  it('refuses to build into a cell a falling body is passing through', () => {
    const sim = make(); cmd(sim, { type: 'setBlock', pos: [8, 20, 5], voxel: 4 })
    const bodies = (sim as unknown as { gravity: { bodies: { y256: number }[] } }).gravity.bodies
    until(sim, () => bodies.length === 1 && bodies[0]!.y256 < 15 * 256)
    const y = bodies[0]!.y256 >> 8
    let committed = false
    expect(sim.workers!.port.edit([8, y, 5], 0, 2, () => { committed = true })).toBe(false)
    expect(committed).toBe(false); expect(sim.store.getVoxel(8, y, 5)).toBe(0)
  })
  it('reports the blocker of the capable worker, not a missing material of an idle one', () => {
    const sim = make(ctx => { for (let z = 0; z < 32; z++) for (let y = 4; y <= 15; y++) ctx.set(10, y, z, 1) })
    spawn(sim, [5, 4, 5], [{ block: 2, count: 4 }]); spawn(sim, [5, 4, 9])
    cmd(sim, { type: 'workBuild', min: [20, 4, 5], max: [20, 4, 5], voxel: 2 })
    for (let i = 0; i < 60; i++) sim.step()
    const reasons = new Set<string | undefined>()
    for (let i = 0; i < 60; i++) { sim.step(); reasons.add(sim.workers!.publication().orders[0]?.reason) }
    expect([...reasons]).toEqual(['no-access'])
  })
  it('bounds the per-worker access failure cache of each task', () => {
    const sim = make(ctx => { for (let z = 0; z < 32; z++) for (let y = 4; y <= 15; y++) ctx.set(10, y, z, 1); for (let x = 24; x <= 27; x++) for (let z = 24; z <= 27; z++) ctx.set(x, 4, z, 1) })
    for (let i = 0; i < 64; i++) spawn(sim, [1 + i % 4 * 2, 4, 1 + Math.floor(i / 4) * 2 % 31])
    cmd(sim, { type: 'workDig', min: [24, 4, 24], max: [27, 4, 27] })
    for (let i = 0; i < 200; i++) sim.step()
    const tasks = (sim.workers as unknown as { tasks: { failures: Map<number, unknown> }[] }).tasks
    expect(tasks).toHaveLength(16)
    expect(Math.max(...tasks.map(t => t.failures.size))).toBeLessThanOrEqual(32)
  })
  it('does not let implementation-approximated Math.hypot decide authoritative state', () => {
    const run = () => {
      const sim = make(ctx => ctx.set(8, 4, 5, 1)); spawn(sim)
      cmd(sim, { type: 'unitMove', ids: [1], pos: [6, 4, 5] }); until(sim, () => sim.workers!.view(1)?.state === 'idle')
      cmd(sim, { type: 'workDig', min: [8, 4, 5], max: [8, 4, 5] }); until(sim, () => sim.store.getVoxel(8, 4, 5) === 0)
      return sim.hash()
    }
    const exact = run(), hypot = Math.hypot
    Math.hypot = (...v: number[]) => hypot(...v) * (1 + 2 ** -50)
    try { expect(run()).toBe(exact) } finally { Math.hypot = hypot }
  })
  it('returns to idle and takes work after an escape search fails', () => {
    const pit = [[4, 5], [6, 5], [5, 4], [5, 6]] as const
    const sim = make(ctx => { for (const [x, z] of pit) for (let y = 4; y <= 6; y++) ctx.set(x, y, z, 1) }); spawn(sim)
    cmd(sim, { type: 'workBuild', min: [5, 5, 5], max: [5, 5, 5], voxel: 2 })
    for (let i = 0; i < 120; i++) sim.step()
    cmd(sim, { type: 'workCancel', order: 1 })
    for (const [x, z] of pit) for (let y = 4; y <= 6; y++) cmd(sim, { type: 'setBlock', pos: [x, y, z], voxel: 0 })
    cmd(sim, { type: 'workDig', min: [10, 3, 10], max: [10, 3, 10] })
    until(sim, () => sim.store.getVoxel(10, 3, 10) === 0, 400)
    until(sim, () => !sim.workers!.busy, 100)
  })
  it('caps the stale-search backoff exponent', () => {
    expect([1, 5, 31, 32, 40].map(staleBackoff)).toEqual([2, 32, 32, 32, 32])
  })
  it('restores the access failures of a parked task when it returns to the frontier', () => {
    const sim = make(ctx => { for (let z = 0; z < 32; z++) for (let y = 4; y <= 15; y++) ctx.set(10, y, z, 1); ctx.set(20, 4, 5, 1) })
    spawn(sim); cmd(sim, { type: 'workDig', min: [20, 4, 5], max: [20, 4, 5] })
    until(sim, () => sim.workers!.publication().orders[0]?.reason === 'no-access')
    const w = sim.workers as unknown as { park(): boolean; expand(): void; tasks: { reason?: string; failures: Map<number, unknown> }[] }
    expect(w.park()).toBe(true); expect(w.tasks).toHaveLength(0)
    w.expand()
    expect(w.tasks[0]).toMatchObject({ reason: 'no-access' }); expect(w.tasks[0]!.failures.has(1)).toBe(true)
  })
  it('does not issue a search that retargeting immediately cancels', () => {
    const sim = make(); spawn(sim, [5, 4, 5]); spawn(sim, [5, 4, 9])
    const nav = sim.workers!.nav, request = nav.request.bind(nav), searches: { status: string; spent: number }[] = []
    nav.request = (...args) => { const s = request(...args); searches.push(s); return s }
    cmd(sim, { type: 'unitMove', ids: [1], pos: [15, 4, 5] }); cmd(sim, { type: 'unitMove', ids: [2], pos: [10, 4, 5] })
    until(sim, () => sim.workers!.view(1)!.x256 >> 8 === 10)
    cmd(sim, { type: 'unitCancel', ids: [1] })
    until(sim, () => sim.workers!.view(2)?.state === 'idle', 600)
    expect(searches.filter(s => s.status === 'cancelled' && !s.spent)).toEqual([])
  })
  it('parks tasks nobody can take for lack of material so later orders still expand', () => {
    const sim = make(); spawn(sim)
    cmd(sim, { type: 'workBuild', min: [10, 4, 10], max: [29, 4, 29], voxel: 2 })
    for (let i = 0; i < 20; i++) sim.step()
    cmd(sim, { type: 'workDig', min: [5, 3, 8], max: [5, 3, 8], priority: 255 })
    until(sim, () => sim.store.getVoxel(5, 3, 8) === 0, 400)
  })
  it('retries an access failure once a transient structural check is over', () => {
    const sim = new Simulation({ buffers: createWorldBuffers([32, 32, 32]), blocks, seed: 1, randomTicksPerChunk: 0, collapse: { scanCap: 1 }, workers: { materials: { stone: { digTicks: 4 } } } })
    sim.generate({ generateColumn(ctx) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) if (x !== 10) ctx.set(x, y, z, 1); ctx.set(10, 3, 5, 5) } })
    for (let i = 0; i < 50; i++) sim.step()
    spawn(sim); for (let i = 0; i < 5; i++) sim.step()
    for (let x = 14; x < 30; x++) sim.submit(0, ++seq, { type: 'setBlock', pos: [x, 4, 28], voxel: 5 })
    sim.submit(0, ++seq, { type: 'workDig', min: [20, 3, 5], max: [20, 3, 5] })
    until(sim, () => sim.store.getVoxel(20, 3, 5) === 0, 1500)
  })
  it('cancels an order restricted to units that no longer exist', () => {
    const sim = make(); spawn(sim); spawn(sim, [7, 4, 5])
    cmd(sim, { type: 'unitCancel', ids: [1] })
    cmd(sim, { type: 'workDig', min: [10, 0, 10], max: [29, 3, 29], ids: [1] })
    cmd(sim, { type: 'unitDespawn', ids: [1] })
    expect(sim.workers!.publication().orders[0]?.cancelled).toBe(true)
    cmd(sim, { type: 'workDig', min: [5, 3, 8], max: [5, 3, 8] })
    until(sim, () => sim.store.getVoxel(5, 3, 8) === 0, 400)
  })
  it('completes the interior of a multi-layer build', () => {
    const sim = make(); spawn(sim, [5, 4, 5], [{ block: 2, count: 64 }])
    cmd(sim, { type: 'workBuild', min: [10, 4, 10], max: [12, 5, 12], voxel: 2 })
    until(sim, () => sim.workers!.publication().orders[0]?.done === 18, 2000)
  })
  it('drops a stale engineering plan when it yields in traffic', () => {
    const sim = make(); spawn(sim); const u = sim.workers!.units.get(1)!
    u.goal = sim.layout.voxelIndex(12, 4, 5); u.actions = [{ kind: 'walk', pos: [6, 4, 5], voxel: 0 }, { kind: 'dig', pos: [7, 4, 5], voxel: 0 }]; u.actionCursor = 1
    ;(sim.workers as unknown as { yield(u: unknown): void }).yield(u)
    expect(u.actions).toEqual([]); expect(u.actionCursor).toBe(0)
  })
  it('asks the port whether physics is dynamic once per tick, not per unit and task', () => {
    const sim = make(ctx => { for (let z = 0; z < 32; z++) for (let y = 4; y <= 15; y++) ctx.set(10, y, z, 1); for (let x = 24; x <= 27; x++) for (let z = 24; z <= 27; z++) ctx.set(x, 4, z, 1) })
    for (let i = 0; i < 16; i++) spawn(sim, [1 + i % 4 * 2, 4, 1 + Math.floor(i / 4) * 2])
    cmd(sim, { type: 'workDig', min: [24, 4, 24], max: [27, 4, 27] })
    for (let i = 0; i < 60; i++) sim.step()
    const port = sim.workers!.port, busy = port.dynamicBusy
    let calls = 0
    port.dynamicBusy = () => { calls++; return busy() }
    for (let i = 0; i < 10; i++) sim.step()
    expect(calls).toBeLessThanOrEqual(10)
  })
  it('blocks only nearby bodies when replanning around traffic', () => {
    const sim = make(); spawn(sim, [5, 4, 5]); spawn(sim, [12, 4, 5])
    for (let i = 0; i < 40; i++) spawn(sim, [2 + i % 10 * 3, 4, 20 + Math.floor(i / 10) * 3])
    const nav = sim.workers!.nav, request = nav.request.bind(nav)
    let largest = 0
    nav.request = (start, goals, blocked, options) => { largest = Math.max(largest, blocked?.size ?? 0); return request(start, goals, blocked, options) }
    cmd(sim, { type: 'unitMove', ids: [1], pos: [12, 4, 5] }); cmd(sim, { type: 'unitMove', ids: [2], pos: [5, 4, 5] })
    until(sim, () => [1, 2].every(id => sim.workers!.view(id)?.state === 'idle'), 600)
    expect(largest).toBeGreaterThan(0); expect(largest).toBeLessThanOrEqual(8 * 4)
  })
  it('builds a two-layer slab inside-out from scaffold cells of its own layer', () => {
    const sim = make(); spawn(sim, [5, 4, 5], [{ block: 2, count: 64 }]); spawn(sim, [5, 4, 7], [{ block: 2, count: 64 }])
    cmd(sim, { type: 'workBuild', min: [10, 4, 10], max: [14, 5, 14], voxel: 2 })
    until(sim, () => sim.workers!.publication().orders[0]?.done === 50, 4000)
  })
  it('falls back to building the border from outside when an inner ring cannot be finished', () => {
    const sim = make(ctx => ctx.set(11, 4, 11, 1)); spawn(sim, [5, 4, 5], [{ block: 2, count: 16 }])
    cmd(sim, { type: 'workBuild', min: [10, 4, 10], max: [12, 4, 12], voxel: 2 })
    until(sim, () => sim.workers!.publication().orders[0]?.done === 8, 2000)
    expect(sim.store.getVoxel(11, 4, 11)).toBe(1)
  })
  it('treats a body passing over a build target as traffic, not a changed target', () => {
    const sim = make(); spawn(sim, [5, 4, 5], [{ block: 2, count: 4 }]); spawn(sim, [5, 4, 9])
    cmd(sim, { type: 'workBuild', min: [8, 4, 5], max: [8, 4, 5], voxel: 2 })
    until(sim, () => sim.workers!.view(1)?.state === 'working')
    const u = sim.workers!.units.get(1)!, occupied = (sim.workers as unknown as { occupied: Map<number, number> }).occupied
    u.progress = u.duration; occupied.set(u.task!.p, 2)
    sim.step()
    expect(sim.workers!.view(1)?.reason).toBe('traffic')
    occupied.delete(sim.layout.voxelIndex(8, 4, 5))
    until(sim, () => sim.store.getVoxel(8, 4, 5) === 2, 200)
  })
  it('never strands builders on top of a wall too tall to finish', () => {
    const sim = make(); spawn(sim, [5, 4, 5], [{ block: 2, count: 64 }]); spawn(sim, [5, 4, 7], [{ block: 2, count: 64 }])
    cmd(sim, { type: 'workBuild', min: [10, 4, 5], max: [14, 7, 5], voxel: 2 })
    for (let i = 0; i < 1500; i++) sim.step()
    cmd(sim, { type: 'workCancel', order: 1 })
    cmd(sim, { type: 'unitMove', ids: [1, 2], pos: [3, 4, 20] })
    until(sim, () => [1, 2].every(id => { const u = sim.workers!.view(id)!; return u.state === 'idle' && u.y256 === 1024 && u.z256 >> 8 >= 18 }), 600)
  })
  it('keeps an access failure while unrelated work happens elsewhere and retries once a nearby edit opens the way', () => {
    const sim = make(ctx => { for (let z = 0; z < 32; z++) for (let y = 4; y <= 15; y++) ctx.set(10, y, z, 1); ctx.set(20, 4, 5, 1) })
    spawn(sim); spawn(sim, [20, 4, 20])
    cmd(sim, { type: 'workDig', min: [20, 4, 5], max: [20, 4, 5], ids: [1] })
    until(sim, () => sim.workers!.publication().orders[0]?.reason === 'no-access')
    const nav = sim.workers!.nav, request = nav.request.bind(nav), start = sim.layout.voxelIndex(5, 4, 5)
    let retries = 0
    nav.request = (...args) => { if (args[0] === start) retries++; return request(...args) }
    cmd(sim, { type: 'workDig', min: [24, 3, 24], max: [27, 3, 27], ids: [2] })
    until(sim, () => sim.workers!.publication().orders[1]?.done === 16, 1500)
    expect(retries).toBeLessThanOrEqual(1)
    cmd(sim, { type: 'fillRegion', min: [10, 4, 5], max: [10, 5, 5], voxel: 0 })
    until(sim, () => sim.store.getVoxel(20, 4, 5) === 0, 600)
  })
  it('parks tasks of an order whose only workers are stopped', () => {
    const sim = make(); spawn(sim); spawn(sim, [7, 4, 5])
    cmd(sim, { type: 'workDig', min: [10, 0, 10], max: [29, 3, 29], ids: [1] })
    cmd(sim, { type: 'unitCancel', ids: [1] })
    cmd(sim, { type: 'workDig', min: [5, 3, 8], max: [5, 3, 8], ids: [2], priority: 255 })
    until(sim, () => sim.store.getVoxel(5, 3, 8) === 0, 400)
  })
  it('rejects an order restricted to incapacitated units', () => {
    const sim = make(); spawn(sim)
    cmd(sim, { type: 'setBlock', pos: [5, 12, 5], voxel: 4 })
    until(sim, () => sim.workers!.view(1)?.state === 'incapacitated')
    sim.submit(0, ++seq, { type: 'workDig', min: [8, 3, 8], max: [8, 3, 8], ids: [1] })
    expect(sim.step().acks[0]?.ok).toBe(false)
  })
  it('leaves its own build designation without crossing another one', () => {
    const sim = make(); spawn(sim, [5, 4, 5])
    cmd(sim, { type: 'workBuild', min: [4, 4, 4], max: [6, 4, 6], voxel: 2 })
    cmd(sim, { type: 'workBuild', min: [15, 4, 0], max: [15, 4, 20], voxel: 2 })
    cmd(sim, { type: 'unitMove', ids: [1], pos: [25, 4, 5] })
    for (let tick = 0; tick < 600 && !(sim.workers!.view(1)?.state === 'idle' && sim.workers!.view(1)!.x256 >> 8 === 25); tick++) {
      sim.step(); const u = sim.workers!.view(1)!
      expect(u.x256 >> 8 === 15 && u.z256 >> 8 <= 20, `stood in the other designation at ${u.x256 >> 8},${u.z256 >> 8}`).toBe(false)
    }
    expect(sim.workers!.view(1)?.x256).toBe(25 * 256 + 128)
  })
  it('never engineers a bridge into a designated build cell', () => {
    const sim = make(ctx => { for (let z = 0; z < 32; z++) for (let x = 8; x <= 9; x++) for (let y = 0; y < 4; y++) ctx.set(x, y, z, 0) }, { materials: { stone: { digTicks: 4, buildTicks: 3 }, planks: { digTicks: 2, buildTicks: 3 } } })
    spawn(sim, [5, 4, 5], [{ block: 1, count: 4 }])
    cmd(sim, { type: 'workBuild', min: [8, 3, 5], max: [9, 3, 5], voxel: 2 })
    cmd(sim, { type: 'unitMove', ids: [1], pos: [11, 4, 5], buildBlock: 1 })
    for (let i = 0; i < 600; i++) { sim.step(); expect([sim.store.getVoxel(8, 3, 5), sim.store.getVoxel(9, 3, 5)]).not.toContain(1) }
  })
  it('forgets a despawned worker in parked task histories', () => {
    const sim = make(ctx => { for (let z = 0; z < 32; z++) for (let y = 4; y <= 15; y++) ctx.set(10, y, z, 1); ctx.set(20, 4, 5, 1) })
    spawn(sim); cmd(sim, { type: 'workDig', min: [20, 4, 5], max: [20, 4, 5] })
    until(sim, () => sim.workers!.publication().orders[0]?.reason === 'no-access')
    const w = sim.workers as unknown as { time: number; park(): boolean; parkedFailures: Map<number, { failures: Map<number, unknown> }>; tasks: { failures: Map<number, unknown> }[] }
    w.time++; expect(w.park()).toBe(true)
    cmd(sim, { type: 'unitDespawn', ids: [1] })
    expect([...w.parkedFailures.values(), ...w.tasks].every(h => !h.failures.has(1))).toBe(true)
  })
  it('starts a new task without the stale backoff of an earlier one', () => {
    const sim = make(); spawn(sim); const u = sim.workers!.units.get(1)!
    u.stale = 4; (sim.workers as unknown as { block(u: unknown, r: string): void }).block(u, 'no-access')
    expect(u.stale).toBe(0)
  })
  it('walks diagonally past a block corner its body never touches', () => {
    const sim = make(ctx => { ctx.set(10, 4, 5, 1); ctx.set(10, 5, 5, 1) }); spawn(sim, [10, 4, 4])
    cmd(sim, { type: 'unitMove', ids: [1], pos: [3, 4, 20] })
    let blocked = false
    for (let i = 0; i < 300 && sim.workers!.view(1)?.state !== 'idle'; i++) { sim.step(); if (sim.workers!.view(1)?.state === 'blocked') blocked = true }
    expect(blocked).toBe(false); expect(sim.workers!.view(1)).toMatchObject({ state: 'idle', x256: 3 * 256 + 128, z256: 20 * 256 + 128 })
  })
  it('leaves an unsafe pose when ordered to move instead of blocking in place', () => {
    const sim = make(); spawn(sim)
    cmd(sim, { type: 'setBlock', pos: [5, 3, 5], voxel: 4 })
    cmd(sim, { type: 'unitMove', ids: [1], pos: [10, 4, 5] })
    until(sim, () => sim.workers!.view(1)?.state === 'idle' && sim.workers!.view(1)!.x256 === 10 * 256 + 128, 300)
  })
  it('steps off an unsafe floor on its own when idle', () => {
    const sim = make(); spawn(sim)
    cmd(sim, { type: 'setBlock', pos: [5, 3, 5], voxel: 4 })
    until(sim, () => { const u = sim.workers!.view(1)!; return u.state === 'idle' && (u.x256 >> 8 !== 5 || u.z256 >> 8 !== 5) }, 300)
  })
  it('lets an old low-priority order overtake a newer higher-priority one while the crew is busy elsewhere', () => {
    // Planks take 900 ticks here, so the only unit stays busy while order 2 waits and ages.
    const sim = make(ctx => { ctx.set(6, 4, 5, 2); ctx.set(14, 4, 5, 1); ctx.set(4, 4, 5, 1) }, { materials: { stone: { digTicks: 4, buildTicks: 3 }, planks: { digTicks: 900, buildTicks: 3 } } })
    spawn(sim)
    cmd(sim, { type: 'workDig', min: [6, 4, 5], max: [6, 4, 5], priority: 255 })
    until(sim, () => sim.workers!.view(1)?.state === 'working')
    cmd(sim, { type: 'workDig', min: [14, 4, 5], max: [14, 4, 5], priority: 64 })
    until(sim, () => sim.workers!.publication().orders[1]!.effectivePriority === 71, 800)
    // The newer order is nearer the unit, so only aging can put the old one first.
    cmd(sim, { type: 'workDig', min: [4, 4, 5], max: [4, 4, 5], priority: 70 })
    until(sim, () => sim.store.getVoxel(6, 4, 5) === 0, 1000)
    const [, old, fresh] = sim.workers!.publication().orders
    expect(fresh!.effectivePriority).toBeLessThan(old!.effectivePriority)
    expect(sim.workers!.view(1)?.order).toBe(old!.id)
  })
  it('lets a later small order progress next to a dig larger than the frontier, before aging could help it', () => {
    const sim = make()
    cmd(sim, { type: 'workDig', min: [8, 3, 8], max: [27, 3, 27] })
    cmd(sim, { type: 'workDig', min: [2, 3, 29], max: [5, 3, 29] })
    // The units arrive next to the small order, so they take its cells as soon as the frontier holds them.
    spawn(sim, [3, 4, 27]); spawn(sim, [5, 4, 27])
    for (let i = 0; i < 90; i++) sim.step()
    const [big, small] = sim.workers!.publication().orders
    expect(big!.total).toBe(400)
    expect(big!.done).toBeGreaterThan(0); expect(small!.done).toBeGreaterThan(0)
  })
  it('gives a high-priority order submitted while the frontier is full tasks on the next tick', () => {
    const sim = make(); cmd(sim, { type: 'workDig', min: [0, 0, 0], max: [29, 0, 29] })
    const w = sim.workers as unknown as { tasks: { order: { id: number } }[] }
    expect(w.tasks).toHaveLength(256)
    cmd(sim, { type: 'workDig', min: [0, 2, 0], max: [3, 2, 3], priority: 200 })
    expect(w.tasks.filter(t => t.order.id === 2).length).toBeGreaterThan(0)
    expect(w.tasks.length).toBeLessThanOrEqual(256)
  })
  it('parks a low-priority task before a high-priority one when a new order needs room', () => {
    const sim = make()
    cmd(sim, { type: 'workDig', min: [0, 0, 0], max: [29, 0, 9], priority: 64 })
    cmd(sim, { type: 'workDig', min: [0, 1, 0], max: [29, 1, 9], priority: 200 })
    const w = sim.workers as unknown as { tasks: { order: { id: number } }[]; share: Map<number, number> }, count = (id: number) => w.tasks.filter(t => t.order.id === id).length
    // The first order filled the frontier alone; wait until parking has brought it down to its share.
    until(sim, () => w.tasks.length === 256 && count(1) === w.share.get(1))
    const low = count(1), high = count(2)
    cmd(sim, { type: 'workDig', min: [0, 2, 0], max: [29, 2, 9], priority: 128 })
    expect(count(3)).toBeGreaterThan(0)
    expect(count(1)).toBeLessThan(low); expect(count(2)).toBe(high)
  })
  it('parks the tasks of an order within its share only after 100 ticks without crew', () => {
    const sim = make(); spawn(sim)
    cmd(sim, { type: 'workDig', min: [0, 0, 0], max: [29, 0, 29], ids: [1] })
    cmd(sim, { type: 'unitCancel', ids: [1] })
    const w = sim.workers as unknown as { park(): boolean }
    for (let i = 0; i < 90; i++) sim.step()
    expect(w.park()).toBe(false)
    for (let i = 0; i < 20; i++) sim.step()
    expect(w.park()).toBe(true)
  })
  it('lets two units work neighbouring tasks at once when one task has a single work pose the other could use', () => {
    // (8,4,7) sits in a stone pocket: its only work pose is (8,4,6), which is also a pose of (8,4,5).
    const sim = make(ctx => {
      ctx.set(8, 4, 5, 1); ctx.set(8, 4, 7, 1)
      for (let y = 4; y <= 6; y++) { ctx.set(7, y, 7, 1); ctx.set(9, y, 7, 1); for (let x = 7; x <= 9; x++) ctx.set(x, y, 8, 1) }
    })
    spawn(sim, [6, 4, 5]); spawn(sim, [10, 4, 6])
    cmd(sim, { type: 'workDig', min: [8, 4, 5], max: [8, 4, 7] })
    let together = false
    for (let i = 0; i < 200 && !together; i++) {
      sim.step()
      const views = [1, 2].map(id => sim.workers!.view(id)!)
      for (const v of views) expect(v.reason, JSON.stringify(v)).not.toBe('traffic')
      expect(sim.workers!.publication().orders[0]?.reason).not.toBe('traffic')
      together = views.every(v => v.state === 'working')
    }
    expect(together).toBe(true)
  })
  it('releases the claim of a unit that neither moves nor works for 200 ticks and records the failure', () => {
    const sim = make(ctx => ctx.set(28, 4, 5, 1), { searchCap: 16 }); spawn(sim, [2, 4, 5])
    cmd(sim, { type: 'workDig', min: [28, 4, 5], max: [28, 4, 5] })
    const w = sim.workers as unknown as { tasks: { claim: number; failures: Map<number, { reason: string }> }[] }
    expect(w.tasks[0]!.claim).toBe(1)
    // An edit next to the unit every tick keeps its sliced search stale, so it never sets off.
    let released = -1
    for (let i = 0; i < 260 && released < 0; i++) { cmd(sim, { type: 'setBlock', pos: [3, 8, 5], voxel: i & 1 }); if (!w.tasks[0]!.claim) released = i }
    expect(released).toBeGreaterThanOrEqual(190); expect(released).toBeLessThanOrEqual(205)
    expect(w.tasks[0]!.failures.get(1)?.reason).toBe('traffic')
  })
  describe('assignment at scale', () => {
    /** A 256² floor with one long planks dig next to each of 200 spread units. */
    function field(options: WorkerOptions = {}, offset = 1) {
      const spots: [number, number][] = []
      for (let j = 0; j < 14; j++) for (let i = 0; i < 15 && spots.length < 200; i++) spots.push([8 + i * 17, 8 + j * 17])
      const sim = new Simulation({ buffers: createWorldBuffers([256, 32, 256]), blocks, seed: 1, randomTicksPerChunk: 0, workers: { maxOrders: 256, materials: { stone: { digTicks: 4 }, planks: { digTicks: 400 } }, ...options } })
      sim.generate({ generateColumn(ctx, cx, cz) {
        for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) ctx.set(x, y, z, 1)
        for (const [x, z] of spots) if ((x + offset) >> 5 === cx && z >> 5 === cz) ctx.set(x + offset - cx * 32, 4, z - cz * 32, 2)
      } })
      for (const [x, z] of spots) sim.submit(0, ++seq, { type: 'unitSpawn', pos: [x, 4, z] })
      sim.step()
      for (const [x, z] of spots) sim.submit(0, ++seq, { type: 'workDig', min: [x + offset, 4, z], max: [x + offset, 4, z] })
      return sim
    }
    const working = (sim: Simulation) => [...sim.workers!.units.values()].filter(u => u.state === 'working').length
    it('puts 200 idle units to work on 200 spread tasks within 60 ticks without exceeding the search cap', () => {
      const sim = field({}, 3)
      expect(sim.workers!.units.size).toBe(200)
      let ticks = 0
      for (; ticks < 60 && working(sim) < 200; ticks++) expect(sim.step().workers!.stats.visited).toBeLessThanOrEqual(4096)
      expect(working(sim)).toBe(200)
    })
    it('assigns more units per tick when many are idle', () => {
      // At most one unit in two waits: 100 assignments on the first tick, then half of those left.
      const sim = field({ assignmentShare: 2 })
      let ticks = 0
      for (; ticks < 30 && working(sim) < 200; ticks++) sim.step()
      expect(ticks).toBeLessThanOrEqual(8)
    })
    it('keeps a fixed assignment cap when one is given', () => {
      const sim = field({ assignmentCap: 16, assignmentShare: 2 })
      let ticks = 0
      for (; ticks < 30 && working(sim) < 200; ticks++) sim.step()
      expect(ticks).toBeGreaterThanOrEqual(13)
    })
    it('looks for tasks near the unit first, and further only when few are near', () => {
      const sim = new Simulation({ buffers: createWorldBuffers([256, 32, 256]), blocks, seed: 1, randomTicksPerChunk: 0, workers: { materials: { stone: { digTicks: 4 } } } })
      sim.generate({ generateColumn(ctx) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) ctx.set(x, y, z, 1) } })
      const w = sim.workers as unknown as { candidates(u: unknown): { pos: number[] }[]; tasks: unknown[]; taskIndex: Map<number, unknown[]> }
      // No unit takes these tasks; the probe stands in chunk column (0, 0).
      const probe = { id: 1, x: 2 * 256 + 128, y: 4 * 256, z: 2 * 256 + 128 }
      cmd(sim, { type: 'workDig', min: [200, 3, 200], max: [203, 3, 203] })
      cmd(sim, { type: 'workDig', min: [8, 3, 8], max: [11, 3, 9] })
      expect(w.candidates(probe)).toHaveLength(24)
      cmd(sim, { type: 'workDig', min: [8, 3, 12], max: [11, 3, 13] })
      const near = w.candidates(probe)
      expect(near).toHaveLength(16); expect(near.every(t => t.pos[0]! < 32 && t.pos[2]! < 32)).toBe(true)
      expect([...w.taskIndex.values()].reduce((n, l) => n + l.length, 0)).toBe(w.tasks.length)
    })
    it('sends a unit to a far higher-priority order even with plenty of low-priority work nearby', () => {
      const sim = new Simulation({ buffers: createWorldBuffers([256, 32, 256]), blocks, seed: 1, randomTicksPerChunk: 0, workers: { materials: { stone: { digTicks: 4 } } } })
      sim.generate({ generateColumn(ctx) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) ctx.set(x, y, z, 1) } })
      cmd(sim, { type: 'unitCancel', ids: [spawn(sim, [2, 4, 2])] })
      sim.submit(0, ++seq, { type: 'workDig', min: [8, 3, 8], max: [12, 3, 11], priority: 64 })
      sim.submit(0, ++seq, { type: 'workDig', min: [200, 3, 200], max: [200, 3, 200], priority: 200 })
      sim.step()
      expect(sim.workers!.view(1)?.order).toBe(2)
    })
    it('keeps the task index in step with the frontier through parking and completion', () => {
      const sim = make(); spawn(sim, [3, 4, 26]); spawn(sim, [5, 4, 26])
      cmd(sim, { type: 'workDig', min: [8, 3, 8], max: [27, 3, 27] })
      cmd(sim, { type: 'workDig', min: [2, 3, 29], max: [5, 3, 29], priority: 200 })
      const w = sim.workers as unknown as { tasks: { pos: number[] }[]; taskIndex: Map<number, { pos: number[] }[]> }
      for (let i = 0; i < 120; i++) {
        sim.step()
        const indexed = [...w.taskIndex.values()].flat()
        expect(indexed.length).toBe(w.tasks.length)
        for (const t of w.tasks) expect(indexed.includes(t)).toBe(true)
        for (const [column, list] of w.taskIndex) for (const t of list) expect((t.pos[0]! >> 5) + (t.pos[2]! >> 5) * sim.layout.cx).toBe(column)
      }
    })
  })
  it('hashes the tick of a unit\'s last progress', () => {
    const sim = make(); spawn(sim); const u = sim.workers!.units.get(1)! as unknown as { progressAt: number }, before = sim.hash()
    u.progressAt--; expect(sim.hash()).not.toBe(before)
  })
  it('hashes when an order last had an eligible worker', () => {
    const sim = make(); spawn(sim); cmd(sim, { type: 'workDig', min: [8, 3, 8], max: [8, 3, 8], ids: [1] })
    const o = (sim.workers as unknown as { orders: { noCrewSince: number }[] }).orders[0]!, before = sim.hash()
    expect(o.noCrewSince).toBe(-1)
    o.noCrewSince = 3; expect(sim.hash()).not.toBe(before)
  })
  it('hashes the tick an order last progressed', () => {
    const sim = make(ctx => ctx.set(8, 4, 5, 1)); spawn(sim); cmd(sim, { type: 'workDig', min: [8, 4, 5], max: [8, 4, 5] })
    const o = (sim.workers as unknown as { orders: { idleSince: number }[] }).orders[0]!, before = sim.hash()
    o.idleSince--; expect(sim.hash()).not.toBe(before)
  })
  it('collects nearby persistent overflow and publishes a removal delta', () => {
    const sim = make(ctx => ctx.set(8, 4, 5, 1), { inventoryCapacity: 1 }); spawn(sim, [5, 4, 5], [{ block: 2, count: 1 }])
    cmd(sim, { type: 'workDig', min: [8, 4, 5], max: [8, 4, 5] }); until(sim, () => sim.store.getVoxel(8, 4, 5) === 0)
    cmd(sim, { type: 'workBuild', min: [7, 4, 6], max: [7, 4, 6], voxel: 2 }); until(sim, () => sim.store.getVoxel(7, 4, 6) === 2)
    const result = cmd(sim, { type: 'unitCollect', ids: [1] })
    expect(result.workers!.drops).toEqual([{ pos: [8, 4, 5], block: 1, count: 0 }]); expect(sim.workers!.viewDrops()).toEqual([])
    expect(sim.workers!.view(1)?.stock).toContainEqual({ block: 1, count: 1 })
  })
})
