import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import type { SimSnapshot } from '../src/sim/snapshot.ts'
import type { GameSystem, SystemContext } from '../src/sim/systems.ts'
import type { UnitEvent } from '../src/sim/workers/types.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { toRestore } from './persistHelpers.ts'

const blocks = [{ name: 'stone' }, { name: 'planks' }]
const BASE = 40
type Script = (c: SystemContext) => void

/** A 32³ world with a stone floor (y < 4), materials that take BASE ticks to build or dig, and a scripted test system. */
function harness(from?: SimSnapshot) {
  const events: UnitEvent[] = []
  let script: Script | null = null
  let ctx!: SystemContext
  const sys: GameSystem = { name: 'test', version: 1, snapshot: () => null, tick: c => { ctx = c; events.push(...c.units.events); const s = script; script = null; s?.(c) } }
  const sim = new Simulation({ buffers: createWorldBuffers([32, 32, 32]), blocks, seed: 1, randomTicksPerChunk: 0, log: () => {}, systems: [sys],
    workers: { materials: { stone: { digTicks: BASE, buildTicks: BASE }, planks: { digTicks: BASE, buildTicks: BASE } } } })
  if (from) sim.restore(toRestore(from))
  else sim.generate({ generateColumn(g) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) g.set(x, y, z, 1) } })
  sim.step()
  const run = <T>(s: (c: SystemContext) => T): T => { let out!: T; script = c => { out = s(c) }; sim.step(); return out }
  /** Steps until an event of `type` for `id` arrives; returns the ticks it took from `t0`. */
  const ticksTo = (id: number, type: UnitEvent['type'], t0: number, cap = 600) => {
    for (let i = 0; i < cap && !events.some(e => e.unit === id && e.type === type); i++) sim.step()
    expect(events.some(e => e.unit === id && e.type === type)).toBe(true)
    return sim.tick - t0
  }
  return { sim, events, run, ticksTo, get ctx() { return ctx } }
}

/** Ticks from the command to `built` (or `dug`) for a unit spawned next to the target, at `speed` (none: never set). */
function timed(kind: 'build' | 'dig', speed?: number): number {
  const h = harness()
  const id = h.run(c => c.units.spawn([5, 4, 5]))
  if (speed !== undefined) h.run(c => c.units.setWorkSpeed(id, speed))
  const t0 = h.sim.tick
  if (kind === 'build') h.run(c => c.units.build(id, [6, 4, 5], 2))
  else h.run(c => c.units.dig(id, [6, 3, 5]))
  return h.ticksTo(id, kind === 'build' ? 'built' : 'dug', t0)
}

describe('a unit\'s work speed', () => {
  // Measured on b09d0aa (before work speed existed): the build and the dig of a 40-tick material next to the unit.
  const BUILD_AT_B09 = 44, DIG_AT_B09 = 44

  it('defaults to today\'s timing', () => {
    expect(timed('build')).toBe(BUILD_AT_B09)
    expect(timed('dig')).toBe(DIG_AT_B09)
    expect(timed('build', 1)).toBe(BUILD_AT_B09)
  })

  it('divides the duration of a step that starts after it is set', () => {
    expect(timed('build', 1.1)).toBe(BUILD_AT_B09 - (BASE - Math.round(BASE / 1.1)))
    expect(timed('build', 0.9)).toBe(BUILD_AT_B09 + (Math.round(BASE / 0.9) - BASE))
    expect(timed('dig', 1.1)).toBe(DIG_AT_B09 - (BASE - Math.round(BASE / 1.1)))
    expect(timed('dig', 0.9)).toBe(DIG_AT_B09 + (Math.round(BASE / 0.9) - BASE))
    expect(BASE - Math.round(BASE / 1.1)).toBe(4)
    expect(Math.round(BASE / 0.9) - BASE).toBe(4)
  })

  it('never makes a step shorter than one tick', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.setWorkSpeed(id, 1000))
    h.run(c => c.units.build(id, [6, 4, 5], 2))
    h.ticksTo(id, 'built', h.sim.tick)
    expect(h.sim.store.getVoxel(6, 4, 5)).toBe(2)
  })

  it('a step under way keeps its duration', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    const t0 = h.sim.tick
    h.run(c => c.units.build(id, [6, 4, 5], 2))
    for (let i = 0; i < 300 && !(h.ctx.units.view(id)!.state === 'working' && h.ctx.units.view(id)!.progress >= BASE / 2); i++) h.sim.step()
    expect(h.ctx.units.view(id)!.duration).toBe(BASE)
    h.run(c => c.units.setWorkSpeed(id, 2))
    expect(h.ctx.units.view(id)!.duration).toBe(BASE)
    expect(h.ticksTo(id, 'built', t0)).toBe(BUILD_AT_B09)
  })

  it('refuses a speed that is not a positive finite number, and a unit that is unknown, gone or not controlled', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    for (const bad of [0, -1, NaN, Infinity]) expect(() => h.run(c => c.units.setWorkSpeed(id, bad))).toThrow('work speed must be a positive finite number')
    expect(() => h.run(c => c.units.setWorkSpeed(999, 1))).toThrow('unknown unit 999')
    h.run(c => c.units.despawn(id))
    expect(() => h.run(c => c.units.setWorkSpeed(id, 1))).toThrow(`unknown unit ${id}`)
    h.sim.submit(0, 1, { type: 'unitSpawn', pos: [3, 4, 3] }); h.sim.step()
    const plain = [...h.sim.workers!.units.keys()][0]!
    expect(() => h.run(c => c.units.setWorkSpeed(plain, 1))).toThrow(`unit ${plain} is not controlled`)
  })

  it('is part of the determinism hash, except at 1', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    const u = h.sim.workers!.units.get(id) as unknown as { speed: number }
    const before = h.sim.hash()
    u.speed = 1.1
    expect(h.sim.hash()).not.toBe(before)
    u.speed = 1
    expect(h.sim.hash()).toBe(before)
  })

  // The engine rebuilds routes, claims and retries on a load (workers plan deviation 6), so a restored run does not hash as
  // the uninterrupted one: two loads of one save replay identically, and the restored unit's work keeps its timing.
  it('survives a save: the next step after the restore takes its duration, two loads replay identically, and the work ends on the uninterrupted tick', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.setWorkSpeed(id, 1.1))
    h.run(c => c.units.build(id, [6, 4, 5], 2))
    h.ticksTo(id, 'built', h.sim.tick)
    for (let i = 0; i < 5; i++) h.sim.step() // idle where it stands
    const snap = h.sim.snapshot(null)
    const r = harness(snap), q = harness(snap)
    h.sim.step() // the harness steps a restored run once
    expect(r.sim.workers!.snapshot()).toEqual(h.sim.workers!.snapshot())
    expect(r.sim.workers!.snapshot().units.find(u => u.id === id)!.speed).toBe(1.1)
    for (const s of [h, r, q]) s.run(c => c.units.build(id, [6, 4, 6], 2))
    let working = false, hAt = -1, rAt = -1
    const built = (s: typeof h) => s.events.filter(e => e.unit === id && e.type === 'built').length
    const hBefore = built(h)
    for (let i = 0; i < 80; i++) {
      h.sim.step(); r.sim.step(); q.sim.step()
      expect(q.sim.hash()).toBe(r.sim.hash())
      if (r.ctx.units.view(id)!.state === 'working') { working = true; expect(r.ctx.units.view(id)!.duration).toBe(Math.round(BASE / 1.1)) }
      if (hAt < 0 && built(h) > hBefore) hAt = i
      if (rAt < 0 && built(r) > 0) rAt = i
    }
    expect(working).toBe(true)
    expect(rAt).toBeGreaterThanOrEqual(0)
    expect(rAt).toBe(hAt)
  })
})
