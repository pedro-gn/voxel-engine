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
})
