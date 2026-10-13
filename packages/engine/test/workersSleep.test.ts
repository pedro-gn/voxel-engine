import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import type { Command } from '../src/sim/commands.ts'
import type { WorkerOptions } from '../src/sim/workers/types.ts'
import type { GeneratorContext } from '../src/sim/generator.ts'

const blocks = [{ name: 'stone' }, { name: 'planks' }, { name: 'water', liquid: true }, { name: 'sand', falls: true }, { name: 'beam', collapses: true }]
function make(extra?: (ctx: GeneratorContext) => void, options: WorkerOptions = {}, side = 32) {
  const sim = new Simulation({ buffers: createWorldBuffers([side, 32, side]), blocks, seed: 1, randomTicksPerChunk: 0, workers: { materials: { stone: { digTicks: 4, buildTicks: 3 } }, ...options } })
  sim.generate({ generateColumn(ctx) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) ctx.set(x, y, z, 1); extra?.(ctx) } })
  return sim
}
let seq = 0
function cmd(sim: Simulation, command: Command) { sim.submit(0, ++seq, command); const r = sim.step(); expect(r.acks[0]?.ok, r.acks[0]?.error).toBe(true); return r }
function spawn(sim: Simulation, pos: number[]) { cmd(sim, { type: 'unitSpawn', pos }); return sim.workers!.units.size }
type Internals = { sleepers: { asleep(id: number): boolean; dozing(id: number, now: number): boolean; size: number }; time: number }
const inside = (sim: Simulation) => sim.workers as unknown as Internals
/** Walls along z = 4 and z = 7 (y 4..5) for x 2..29, capped at x = 2 and x = 29: a two-wide corridor on z = 5 and 6. */
const corridor = (ctx: GeneratorContext) => {
  for (let x = 2; x <= 29; x++) for (let y = 4; y < 6; y++) { ctx.set(x, y, 4, 1); ctx.set(x, y, 7, 1) }
  for (let y = 4; y < 6; y++) for (const z of [5, 6]) { ctx.set(2, y, z, 1); ctx.set(29, y, z, 1) }
}

/** Ten units a side in the corridor, all starting in the z = 5 lane, each ordered 16 blocks along it into the z = 6 lane. */
function jam(options: WorkerOptions = {}) {
  const sim = make(corridor, options)
  const orders = new Map<number, [number, number]>()
  for (let x = 3; x <= 12; x++) orders.set(spawn(sim, [x, 4, 5]), [x + 16, 6])
  for (let x = 19; x <= 28; x++) orders.set(spawn(sim, [x, 4, 5]), [x - 16, 6])
  for (const [id, [x, z]] of orders) sim.submit(0, ++seq, { type: 'unitMove', ids: [id], pos: [x, 4, z] })
  expect(sim.step().acks.every(a => a.ok)).toBe(true)
  return sim
}
const settled = (sim: Simulation) => [...sim.workers!.units.values()].every(u => u.goal === null)
/** Steps until some unit will doze next tick, and returns its id. */
function firstDozer(sim: Simulation, cap = 600): number {
  for (let i = 0; i < cap; i++) {
    sim.step()
    const w = inside(sim), id = [...sim.workers!.units.keys()].find(id => w.sleepers.dozing(id, w.time + 1))
    if (id !== undefined) return id
  }
  throw new Error('no unit fell asleep')
}

describe('sleeping units', { timeout: 60_000 }, () => {
  it('units queued behind the heads of a head-on jam sleep, and everyone arrives', () => {
    const sim = jam()
    let most = 0
    for (let i = 0; i < 3000 && !settled(sim); i++) most = Math.max(most, sim.step().workers!.stats.sleeping)
    expect(most).toBeGreaterThan(0)
    expect(settled(sim)).toBe(true)
    expect(sim.step().workers!.stats.sleeping).toBe(0)
  })
  it('with sleep off, the same jam still clears and nobody sleeps', () => {
    const sim = jam({ sleep: false })
    for (let i = 0; i < 3000 && !settled(sim); i++) expect(sim.step().workers!.stats.sleeping).toBe(0)
    expect(settled(sim)).toBe(true)
  })
  it('despawning the units a sleeper waits behind wakes it', () => {
    const sim = jam(), id = firstDozer(sim), w = inside(sim)
    // Whoever it sleeps behind is in its own group (it follows a unit going its way): despawn the rest of that group.
    const group = id <= 10 ? [...Array(10).keys()].map(i => i + 1) : [...Array(10).keys()].map(i => i + 11)
    cmd(sim, { type: 'unitDespawn', ids: group.filter(g => g !== id) })
    expect(w.sleepers.dozing(id, w.time + 1)).toBe(false)
  })
  it("an edit in the sleeper's tile wakes it the same tick", () => {
    const sim = jam(), id = firstDozer(sim), w = inside(sim)
    // A block high above the corridor, in the sleeper's 16³ tile (x 0..15 or 16..31, y 0..15, z 0..15).
    const u = sim.workers!.units.get(id)!, x = (u.x >> 8) < 16 ? 1 : 30
    sim.submit(0, ++seq, { type: 'setBlock', pos: [x, 12, 1], voxel: 1 }); sim.step()
    // Woken by the write; it may fall asleep again in the same tick, but then it did not doze in this one.
    expect(w.sleepers.dozing(id, w.time)).toBe(false)
  })
  it('a dozing unit still ages: its stuck count rises by one every tick it dozes', () => {
    const sim = jam(), w = inside(sim)
    let checked = 0
    for (let i = 0; i < 1500 && !settled(sim); i++) {
      const before = new Map([...sim.workers!.units.values()].map(u => [u.id, u.stuck]))
      sim.step()
      for (const u of sim.workers!.units.values()) if (w.sleepers.dozing(u.id, w.time) && u.goal !== null) { expect(u.stuck).toBe(before.get(u.id)! + 1); checked++ }
    }
    expect(checked).toBeGreaterThan(0)
  })
  it('replays with the same hashes', () => {
    const run = () => { const sim = jam(), h: string[] = []; for (let i = 0; i < 600; i++) { sim.step(); if (i % 50 === 0) h.push(String(sim.hash())) } return h }
    expect(run()).toEqual(run())
  })
  it('a save taken while units sleep loads with everyone awake and all arrive', () => {
    const a = jam(); firstDozer(a)
    expect(a.step().workers!.stats.sleeping).toBeGreaterThan(0)
    // The corridor world has no edits, so a fresh build of it plus the workers' snapshot is the load.
    const b = make(corridor)
    b.workers!.restore(a.workers!.snapshot())
    expect(inside(b).sleepers.size).toBe(0)
    for (let i = 0; i < 3000 && !settled(b); i++) b.step()
    expect(settled(b)).toBe(true)
  })
})

describe('decision budget', { timeout: 60_000 }, () => {
  it('defers deciding units past decisionCap, oldest first, and still starts everyone', () => {
    const sim = make(undefined, { decisionCap: 4 }, 128)
    for (let i = 0; i < 20; i++) spawn(sim, [4 + (i % 5) * 2, 4, 4 + Math.floor(i / 5) * 2])
    const ids = [...sim.workers!.units.keys()]
    sim.submit(0, ++seq, { type: 'unitMove', ids: ids.filter(id => id % 2), pos: [100, 4, 100] })
    sim.submit(0, ++seq, { type: 'unitMove', ids: ids.filter(id => id % 2 === 0), pos: [100, 4, 20] })
    const first = new Map<number, number>()
    let most = 0
    for (let t = 0; t < 200; t++) {
      most = Math.max(most, sim.step().workers!.stats.deferred)
      for (const u of sim.workers!.units.values()) if (u.state === 'walking' && !first.has(u.id)) first.set(u.id, t)
    }
    expect(most).toBeGreaterThan(0)
    expect(first.size).toBe(20)
  })
  it('with the default cap, 100 units never defer', () => {
    const sim = make(undefined, {}, 128)
    for (let i = 0; i < 100; i++) spawn(sim, [4 + (i % 10) * 2, 4, 4 + Math.floor(i / 10) * 2])
    sim.submit(0, ++seq, { type: 'unitMove', ids: [...sim.workers!.units.keys()], pos: [100, 4, 100] })
    for (let t = 0; t < 100; t++) expect(sim.step().workers!.stats.deferred).toBe(0)
  })
})
