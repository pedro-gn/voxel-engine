import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import type { Command } from '../src/sim/commands.ts'
import type { WorkerOptions } from '../src/sim/workers/types.ts'
import type { GeneratorContext } from '../src/sim/generator.ts'

const blocks = [{ name: 'stone' }, { name: 'planks' }, { name: 'water', liquid: true }, { name: 'sand', falls: true }, { name: 'beam', collapses: true }]
function make(extra?: (ctx: GeneratorContext, cx: number, cz: number) => void, options: WorkerOptions = {}, side = 32) {
  const sim = new Simulation({ buffers: createWorldBuffers([side, 32, side]), blocks, seed: 1, randomTicksPerChunk: 0, workers: { materials: { stone: { digTicks: 4, buildTicks: 3 } }, ...options } })
  sim.generate({ generateColumn(ctx, cx, cz) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) ctx.set(x, y, z, 1); extra?.(ctx, cx, cz) } })
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
    const a = jam()
    let sleeping = 0
    for (let i = 0; i < 600 && !sleeping; i++) sleeping = a.step().workers!.stats.sleeping
    expect(sleeping).toBeGreaterThan(0)
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

/** A two-wide corridor along x (walls at z = 4 and z = 7, capped at x = 2 and side - 3) on a floor whose top is y = floorTop. */
function corridorAt(side: number, floorTop: number) {
  return (ctx: GeneratorContext, cx: number, cz: number) => {
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
      const wx = cx * 32 + x, wz = cz * 32 + z
      for (let y = 4; y <= floorTop; y++) ctx.set(x, y, z, 1)
      const y0 = floorTop + 1
      if (wx >= 2 && wx <= side - 3 && (wz === 4 || wz === 7)) for (let y = y0; y < y0 + 2; y++) ctx.set(x, y, z, 1)
      if ((wx === 2 || wx === side - 3) && (wz === 5 || wz === 6)) for (let y = y0; y < y0 + 2; y++) ctx.set(x, y, z, 1)
    }
  }
}
/** n units a side head-on in the z = 5 lane of corridorAt, each ordered d blocks along it into the z = 6 lane. */
function jamAt(side: number, floorTop: number, n: number, d: number, options: WorkerOptions = {}) {
  const sim = new Simulation({ buffers: createWorldBuffers([side, 32, side]), blocks, seed: 1, randomTicksPerChunk: 0, workers: { materials: { stone: { digTicks: 4, buildTicks: 3 } }, ...options } })
  const extra = corridorAt(side, floorTop)
  sim.generate({ generateColumn(ctx, cx, cz) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) ctx.set(x, y, z, 1); extra(ctx, cx, cz) } })
  const y = floorTop + 1, orders: [number, number][] = []
  for (let i = 0; i < n; i++) orders.push([spawn(sim, [3 + i, y, 5]), 3 + i + d])
  for (let i = 0; i < n; i++) orders.push([spawn(sim, [side - 4 - i, y, 5]), side - 4 - i - d])
  for (const [id, x] of orders) sim.submit(0, ++seq, { type: 'unitMove', ids: [id], pos: [x, y, 6] })
  expect(sim.step().acks.every(a => a.ok)).toBe(true)
  return sim
}

describe('sleeping units stay safe and consistent', { timeout: 60_000 }, () => {
  it('a dozing unit whose support is dug out across a tile boundary falls at once', () => {
    // The floor's top is y = 15, so units stand at y = 16: their support is in the tile below theirs.
    const sim = jamAt(32, 15, 10, 16), w = inside(sim)
    // A unit that has dozed three ticks in a row: its owner is stalled too, so nothing else is about to wake it.
    const streak = new Map<number, number>()
    let id = -1
    for (let i = 0; i < 1500 && id < 0; i++) {
      sim.step()
      for (const v of sim.workers!.units.values()) streak.set(v.id, w.sleepers.dozing(v.id, w.time) ? (streak.get(v.id) ?? 0) + 1 : 0)
      id = [...streak].find(([, n]) => n >= 3)?.[0] ?? -1
    }
    expect(id).toBeGreaterThan(0)
    const u = sim.workers!.units.get(id)!
    const set = (sim as unknown as { applySet(x: number, y: number, z: number, v: number, notify: boolean): void }).applySet.bind(sim)
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) set((u.x >> 8) + dx, 15, (u.z >> 8) + dz, 0, true)
    sim.step()
    expect(u.state === 'falling' || u.y < 16 * 256, 'it fell').toBe(true)
  })
  it('a dozing unit keeps holding its body and its plan while it sleeps', () => {
    const sim = jamAt(64, 3, 20, 36), w = inside(sim) as unknown as Internals & { table: { owner(cell: number, t: number): number } }
    const before = new Map<number, { path: readonly number[]; cursor: number }>()
    let dozed = 0
    for (let i = 0; i < 2000 && !settled(sim); i++) {
      sim.step()
      for (const u of sim.workers!.units.values()) {
        if (!w.sleepers.dozing(u.id, w.time)) { before.delete(u.id); continue }
        dozed++
        // Its body cells are its own next tick (an untimed hold, or the timed entries it reserved standing), so no one plans through it.
        for (const p of u.cells) expect(w.table.owner(p, w.time + 1), `unit ${u.id} tick ${w.time} owns cell ${p}`).toBe(u.id)
        const was = before.get(u.id)
        if (was) { expect(u.path, `unit ${u.id} plan changed while asleep`).toBe(was.path); expect(u.cursor).toBe(was.cursor) }
        before.set(u.id, { path: u.path, cursor: u.cursor })
      }
    }
    expect(dozed).toBeGreaterThan(0)
  })
  it('units keep sleeping while water flows elsewhere in the world', () => {
    const sim = jamAt(128, 3, 10, 16)
    cmd(sim, { type: 'fillRegion', min: [90, 4, 90], max: [100, 6, 100], voxel: 3 | (7 << 12) })
    const w = inside(sim)
    let dynamicTicks = 0, dozingWhileDynamic = 0
    for (let i = 0; i < 400; i++) {
      sim.step()
      if (!sim.workers!.port.dynamicBusy()) continue
      dynamicTicks++
      if ([...sim.workers!.units.keys()].some(id => w.sleepers.dozing(id, w.time))) dozingWhileDynamic++
    }
    expect(dynamicTicks).toBeGreaterThan(100)
    expect(dozingWhileDynamic).toBeGreaterThan(0)
  })
})

describe('decision budget exemptions', { timeout: 60_000 }, () => {
  it('a unit walking on along a path it has is never deferred', () => {
    // Zig-zag walls (gaps at alternate ends) so every walk has several straight segments, each its own motion.
    const sim = make((ctx, cx, cz) => { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) { const wx = cx * 32 + x, wz = cz * 32 + z; if (wz === 12 && wx < 56 || wz === 20 && wx > 7) for (let y = 4; y < 6; y++) ctx.set(x, y, z, 1) } }, { decisionCap: 1 }, 64)
    for (let i = 0; i < 10; i++) spawn(sim, [4 + i * 2, 4, 4])
    for (let i = 0; i < 10; i++) sim.submit(0, ++seq, { type: 'unitMove', ids: [i + 1], pos: [4 + i * 2, 4, 30] })
    expect(sim.step().acks.every(a => a.ok)).toBe(true)
    const w = sim.workers as unknown as { deferred: Map<number, number> }
    let most = 0
    for (let t = 0; t < 3000 && ![...sim.workers!.units.values()].every(u => u.state === 'idle' && u.goal === null); t++) {
      most = Math.max(most, sim.step().workers!.stats.deferred)
      for (const id of w.deferred.keys()) { const u = sim.workers!.units.get(id)!; expect(u.path[u.cursor], `unit ${id} deferred mid-path`).toBeUndefined() }
    }
    expect(most).toBeGreaterThan(0)
    expect([...sim.workers!.units.values()].every(u => u.state === 'idle')).toBe(true)
  })
})
