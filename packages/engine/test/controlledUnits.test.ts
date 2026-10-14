import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import type { SimSnapshot } from '../src/sim/snapshot.ts'
import type { GameSystem, SystemContext } from '../src/sim/systems.ts'
import type { UnitEvent } from '../src/sim/workers/types.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { toRestore } from './persistHelpers.ts'

const blocks = [{ name: 'stone' }, { name: 'planks' }]
type Script = (c: SystemContext) => void
type Gen = { set(x: number, y: number, z: number, v: number): void }

/** A 32³ world with a stone floor (y < 4) and a test system that records unit events and runs one script per tick. */
function harness(extra?: (g: Gen) => void, from?: SimSnapshot) {
  const events: UnitEvent[] = []
  let script: Script | null = null
  let ctx!: SystemContext
  const sys: GameSystem = { name: 'test', version: 1, snapshot: () => null, tick: c => { ctx = c; events.push(...c.units.events); const s = script; script = null; s?.(c) } }
  const sim = new Simulation({ buffers: createWorldBuffers([32, 32, 32]), blocks, seed: 1, randomTicksPerChunk: 0, log: () => {}, systems: [sys],
    workers: { materials: { stone: { digTicks: 4, buildTicks: 3 }, planks: { digTicks: 2, buildTicks: 3 } } } })
  if (from) sim.restore(toRestore(from))
  else sim.generate({ generateColumn(g) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) g.set(x, y, z, 1); extra?.(g) } })
  sim.step()
  /** Runs `s` inside the next system tick and returns what it returned. */
  const run = <T>(s: (c: SystemContext) => T): T => { let out!: T; script = c => { out = s(c) }; sim.step(); return out }
  const until = (pred: () => boolean, cap = 600) => { for (let i = 0; i < cap && !pred(); i++) sim.step(); expect(pred()).toBe(true) }
  return { sim, events, run, until, get ctx() { return ctx } }
}
let seq = 0

describe('controlled units', () => {
  it('spawns, walks to a goal and reports arrived', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.goTo(id, [12, 4, 9]))
    h.until(() => h.events.some(e => e.unit === id && e.type === 'arrived'))
    const v = h.ctx.units.view(id)!
    expect([v.x256 >> 8, v.y256 >> 8, v.z256 >> 8]).toEqual([12, 4, 9])
    expect(v.controlled).toBe(true)
    expect(v.intent).toBeNull()
  })

  it('never assigns a controlled unit to a work order', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.sim.submit(0, ++seq, { type: 'workDig', min: [6, 3, 5], max: [6, 3, 5] }); h.sim.step()
    for (let i = 0; i < 100; i++) h.sim.step()
    expect(h.sim.workers!.view(id)!.order).toBe(0)
    expect(h.sim.store.getVoxel(6, 3, 5)).not.toBe(0)
  })

  it('still assigns uncontrolled units next to a controlled one', () => {
    const h = harness()
    h.run(c => c.units.spawn([5, 4, 5]))
    h.sim.submit(0, ++seq, { type: 'unitSpawn', pos: [8, 4, 8] }); h.sim.step()
    h.sim.submit(0, ++seq, { type: 'workDig', min: [6, 3, 5], max: [6, 3, 5] }); h.sim.step()
    h.until(() => h.sim.store.getVoxel(6, 3, 5) === 0)
  })

  it('refuses unitMove on a controlled unit', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.sim.submit(0, ++seq, { type: 'unitMove', ids: [id], pos: [9, 4, 9] })
    expect(h.sim.step().acks[0]).toMatchObject({ ok: false, error: `unit ${id} is controlled by a game system` })
  })

  it('fails a goTo to a pose that cannot be stood on', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.goTo(id, [9, 2, 9])) // inside the stone
    h.until(() => h.events.some(e => e.unit === id && e.type === 'failed'))
    expect(h.events.find(e => e.type === 'failed')).toEqual({ unit: id, type: 'failed', reason: 'no-access' })
  })

  it('fails a goTo with no way there', () => {
    const h = harness((g) => { for (let x = 0; x < 32; x++) for (let y = 4; y < 8; y++) g.set(x, y, 16, 1) }) // a wall across the world
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.goTo(id, [5, 4, 25]))
    h.until(() => h.events.some(e => e.unit === id && e.type === 'failed'))
    expect(h.ctx.units.view(id)!.intent).toBeNull()
  })

  it('stop() ends the intent quietly', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.goTo(id, [25, 4, 25]))
    h.sim.step(); h.sim.step()
    h.run(c => c.units.stop(id))
    for (let i = 0; i < 200; i++) h.sim.step()
    expect(h.events.filter(e => e.unit === id)).toEqual([])
    expect(h.ctx.units.view(id)!.state).toBe('idle')
  })

  it('reports fell with the height when its floor is removed', () => {
    const h = harness((g) => { for (let y = 4; y < 8; y++) g.set(20, y, 20, 1) }) // a pillar
    const id = h.run(c => c.units.spawn([20, 8, 20]))
    h.sim.submit(0, ++seq, { type: 'fillRegion', min: [20, 4, 20], max: [20, 7, 20], voxel: 0 }); h.sim.step()
    h.until(() => h.events.some(e => e.unit === id && e.type === 'fell'))
    expect(h.events.find(e => e.type === 'fell')).toEqual({ unit: id, type: 'fell', height: 4 })
  })

  it('despawn removes the unit', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.despawn(id))
    expect(h.ctx.units.view(id)).toBeUndefined()
  })

  it('throws for unknown or uncontrolled units', () => {
    const h = harness()
    h.sim.submit(0, ++seq, { type: 'unitSpawn', pos: [3, 4, 3] }); h.sim.step()
    const plain = [...h.sim.workers!.units.keys()][0]!
    expect(() => h.run(c => c.units.goTo(plain, [5, 4, 5]))).toThrow(`system test tick: unit ${plain} is not controlled`)
    expect(() => h.run(c => c.units.stop(999))).toThrow('system test tick: unknown unit 999')
  })

  it('a goTo survives a save', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.goTo(id, [20, 4, 20]))
    for (let i = 0; i < 3; i++) h.sim.step()
    const r = harness(undefined, h.sim.snapshot(null))
    expect(r.ctx.units.view(id)!.intent).toEqual({ kind: 'goTo', pos: [20, 4, 20] })
    r.until(() => r.events.some(e => e.unit === id && e.type === 'arrived'))
    const v = r.ctx.units.view(id)!
    expect([v.x256 >> 8, v.y256 >> 8, v.z256 >> 8]).toEqual([20, 4, 20])
  })

  it('digs from a work pose, reports dug and keeps nothing', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.dig(id, [10, 3, 10]))
    h.until(() => h.events.some(e => e.unit === id && e.type === 'dug'))
    expect(h.events.find(e => e.type === 'dug')).toEqual({ unit: id, type: 'dug', pos: [10, 3, 10], voxel: 1 })
    expect(h.sim.store.getVoxel(10, 3, 10)).toBe(0)
    expect(h.sim.workers!.view(id)!.stock).toEqual([])
    expect(h.sim.workers!.viewDrops()).toEqual([])
    expect(h.ctx.units.view(id)!.intent).toBeNull()
  })

  it('builds without stock and reports built', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.build(id, [10, 4, 10], 2))
    h.until(() => h.events.some(e => e.unit === id && e.type === 'built'))
    expect(h.events.find(e => e.type === 'built')).toEqual({ unit: id, type: 'built', pos: [10, 4, 10], voxel: 2 })
    expect(h.sim.store.getVoxel(10, 4, 10)).toBe(2)
  })

  it('fails a dig on air and a build into stone', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.dig(id, [10, 6, 10]))
    h.sim.step()
    expect(h.events.at(-1)).toEqual({ unit: id, type: 'failed', reason: 'target-changed' })
    h.run(c => c.units.build(id, [10, 3, 10], 2))
    h.sim.step()
    expect(h.events.at(-1)).toEqual({ unit: id, type: 'failed', reason: 'target-changed' })
  })

  it('fails when the target changes before the commit', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.dig(id, [12, 3, 12]))
    h.sim.submit(0, ++seq, { type: 'setBlock', pos: [12, 3, 12], voxel: 2 }); h.sim.step()
    h.until(() => h.events.some(e => e.unit === id && e.type === 'failed'))
    expect(h.events.find(e => e.type === 'failed')).toEqual({ unit: id, type: 'failed', reason: 'target-changed' })
    expect(h.sim.store.getVoxel(12, 3, 12)).toBe(2)
  })

  it('a dig intent that loses its task fails instead of hanging', () => {
    const h = harness((g) => { for (let y = 4; y < 8; y++) g.set(20, y, 20, 1) })
    const id = h.run(c => c.units.spawn([20, 8, 20]))
    h.run(c => c.units.dig(id, [25, 3, 25]))
    h.sim.submit(0, ++seq, { type: 'fillRegion', min: [20, 4, 20], max: [20, 7, 20], voxel: 0 }); h.sim.step() // it falls
    h.until(() => h.events.some(e => e.unit === id && e.type === 'failed'))
    expect(h.events.find(e => e.type === 'failed')).toEqual({ unit: id, type: 'failed', reason: 'unsafe' })
    expect(h.ctx.units.view(id)!.intent).toBeNull()
  })

  it('a dig intent whose claim lapses behind a unit that will not move fails with traffic instead of hanging', () => {
    // A closed one-wide corridor (x 3..19 at z 10, walls 3 high) ending in the stone to dig; an uncontrolled unit stands
    // idle in the middle and has nowhere to step aside to, so the digger never reaches its work pose (19, 4, 10).
    const h = harness((g) => {
      for (let x = 2; x <= 20; x++) for (let y = 4; y < 7; y++) { g.set(x, y, 9, 1); g.set(x, y, 11, 1) }
      for (let y = 4; y < 7; y++) { g.set(2, y, 10, 1); g.set(20, y, 10, 1) }
    })
    h.sim.submit(0, ++seq, { type: 'unitSpawn', pos: [12, 4, 10] }); h.sim.step()
    const id = h.run(c => c.units.spawn([4, 4, 10]))
    h.run(c => c.units.dig(id, [20, 4, 10]))
    h.until(() => h.events.some(e => e.unit === id), 1500)
    expect(h.events.filter(e => e.unit === id)).toEqual([{ unit: id, type: 'failed', reason: 'traffic' }])
    expect(h.ctx.units.view(id)!.intent).toBeNull()
    expect(h.sim.store.getVoxel(20, 4, 10)).toBe(1)
  })

  it('a dig intent whose task claim lapses (LEASE_TICKS without progress) fails with traffic', () => {
    // The corridor above ends through the detour search boxed in by bodies (also traffic) a little before the lease would;
    // this drives the lease branch itself: a claim whose last progress is older than LEASE_TICKS (200) lapses.
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.dig(id, [25, 3, 25]))
    const u = h.sim.workers!.units.get(id) as unknown as { progressAt: number; motion: unknown; task: unknown }
    expect(u.task).not.toBeNull()
    u.progressAt -= 1000
    expect(u.motion).toBeNull()
    h.until(() => h.events.some(e => e.unit === id), 5)
    expect(h.events.filter(e => e.unit === id)).toEqual([{ unit: id, type: 'failed', reason: 'traffic' }])
    expect(h.ctx.units.view(id)!.intent).toBeNull()
  })

  it('a dig intent survives a save', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.dig(id, [20, 3, 20]))
    for (let i = 0; i < 3; i++) h.sim.step()
    const r = harness(undefined, h.sim.snapshot(null))
    r.until(() => r.events.some(e => e.unit === id && (e.type === 'dug' || e.type === 'failed')))
    expect(r.events.find(e => e.unit === id)).toEqual({ unit: id, type: 'dug', pos: [20, 3, 20], voxel: 1 })
    expect(r.sim.store.getVoxel(20, 3, 20)).toBe(0)
  })

  it('rejects a non-buildable voxel as a programming error', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    expect(() => h.run(c => c.units.build(id, [10, 4, 10], 0))).toThrow('voxel is not buildable')
  })
})
