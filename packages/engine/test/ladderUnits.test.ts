import { describe, expect, it } from 'vitest'
import { ladderState } from '../src/blocks/shapes.ts'
import { Simulation } from '../src/sim/simulation.ts'
import type { SimSnapshot } from '../src/sim/snapshot.ts'
import type { GameSystem, SystemContext } from '../src/sim/systems.ts'
import type { UnitEvent } from '../src/sim/workers/types.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { packVoxel } from '../src/world/voxel.ts'
import { toRestore } from './persistHelpers.ts'

const blocks = [{ name: 'stone' }, { name: 'planks' }, { name: 'ladder', shape: 'ladder' as const, solid: false, climbable: true }]
const STONE = 1, LADDER = 3
type Gen = { set(x: number, y: number, z: number, v: number): void }

/** A 32³ world, stone below `floor`, `extra` drawn after it, and a test system recording unit events. */
function harness(extra?: (g: Gen) => void, from?: SimSnapshot, floor = 4) {
  const events: UnitEvent[] = []
  let script: ((c: SystemContext) => void) | null = null
  let ctx!: SystemContext
  const sys: GameSystem = { name: 'test', version: 1, snapshot: () => null, tick: c => { ctx = c; events.push(...c.units.events); const s = script; script = null; s?.(c) } }
  const sim = new Simulation({ buffers: createWorldBuffers([32, 32, 32]), blocks, seed: 1, randomTicksPerChunk: 0, log: () => {}, systems: [sys],
    workers: { materials: { stone: { digTicks: 4, buildTicks: 3 }, planks: { digTicks: 2, buildTicks: 3 }, ladder: { buildTicks: 3 } } } })
  if (from) sim.restore(toRestore(from))
  else sim.generate({ generateColumn(g) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < floor; y++) g.set(x, y, z, STONE); extra?.(g) } })
  sim.step()
  const run = <T>(s: (c: SystemContext) => T): T => { let out!: T; script = c => { out = s(c) }; sim.step(); return out }
  const until = (pred: () => boolean, cap = 800) => { for (let i = 0; i < cap && !pred(); i++) sim.step(); expect(pred()).toBe(true) }
  return { sim, events, run, until, get ctx() { return ctx } }
}
/** A stone wall at x = 10 (y 4..10, every z) and ladder rungs at (9, 4..10, 5) hanging on it (+x). */
const shaftWall = (g: Gen) => {
  for (let z = 0; z < 32; z++) for (let y = 4; y <= 10; y++) g.set(10, y, z, STONE)
  for (let y = 4; y <= 10; y++) g.set(9, y, 5, packVoxel(LADDER, ladderState(0)))
}
/** Stone below 12, a 1 × 1 shaft at (5, 9..11, 5), and a ladder at (5, 9, 5) when `ladder`. */
const shaft = (ladder: boolean) => (g: Gen) => {
  for (let y = 9; y <= 11; y++) g.set(5, y, 5, 0)
  if (ladder) g.set(5, 9, 5, packVoxel(LADDER, ladderState(0)))
}

describe('units on ladders', () => {
  it('climbs 6 rungs in 6 × 12 ticks, facing the ladder, and never falls', () => {
    const h = harness(shaftWall)
    const id = h.run(c => c.units.spawn([9, 4, 5]))
    h.run(c => c.units.goTo(id, [9, 10, 5]))
    let t0 = -1, t1 = -1, facing = -1
    for (let t = 0; t < 400 && t1 < 0; t++) {
      h.sim.step()
      const v = h.ctx.units.view(id)!
      if (t0 < 0 && v.y256 > 4 * 256) { t0 = t; facing = v.facing }
      if (v.y256 === 10 * 256) t1 = t
    }
    expect(t0).toBeGreaterThanOrEqual(0)
    expect(Math.abs(t1 - t0 + 1 - 72)).toBeLessThanOrEqual(1)
    expect(facing).toBe(1) // +x: toward the wall the ladder hangs on
    h.until(() => h.events.some(e => e.unit === id && e.type === 'arrived'))
    expect(h.events.some(e => e.type === 'fell')).toBe(false)
  })
  it('stopped mid-shaft, stays at its rung', () => {
    const h = harness(shaftWall)
    const id = h.run(c => c.units.spawn([9, 4, 5]))
    h.run(c => c.units.goTo(id, [9, 10, 5]))
    h.until(() => h.ctx.units.view(id)!.y256 >= 7 * 256)
    h.run(c => c.units.stop(id))
    for (let i = 0; i < 200; i++) h.sim.step()
    const v = h.ctx.units.view(id)!
    expect(v.y256 & 255).toBe(0)
    expect(v.y256 >> 8).toBeGreaterThanOrEqual(7)
    expect([v.x256 >> 8, v.z256 >> 8]).toEqual([9, 5])
    expect(v.state).toBe('idle')
    expect(h.events.some(e => e.type === 'fell')).toBe(false)
  })
  it('restore on a ladder keeps the unit', () => {
    const h = harness(shaftWall)
    const id = h.run(c => c.units.spawn([9, 4, 5]))
    h.run(c => c.units.goTo(id, [9, 10, 5]))
    h.until(() => h.ctx.units.view(id)!.y256 > 6 * 256 + 40 && (h.ctx.units.view(id)!.y256 & 255) !== 0)
    const r = harness(undefined, h.sim.snapshot(null))
    for (let i = 0; i < 200; i++) r.sim.step()
    expect(r.events.some(e => e.type === 'fell')).toBe(false)
    r.until(() => r.events.some(e => e.unit === id && e.type === 'arrived'))
    const v = r.ctx.units.view(id)!
    expect([v.x256 >> 8, v.y256 >> 8, v.z256 >> 8]).toEqual([9, 10, 5])
  })
  it('works the cell under its feet from a ladder, builds a ladder there and climbs down', () => {
    const h = harness(shaft(true), undefined, 12)
    const id = h.run(c => c.units.spawn([5, 9, 5]))
    h.run(c => c.units.dig(id, [5, 8, 5]))
    h.until(() => h.events.some(e => e.unit === id && e.type === 'dug'))
    expect(h.sim.store.getVoxel(5, 8, 5)).toBe(0)
    const rung = packVoxel(LADDER, ladderState(0))
    h.run(c => c.units.build(id, [5, 8, 5], rung))
    h.until(() => h.events.some(e => e.unit === id && e.type === 'built'))
    expect(h.sim.store.getVoxel(5, 8, 5)).toBe(rung)
    h.run(c => c.units.goTo(id, [5, 8, 5]))
    h.until(() => h.events.some(e => e.unit === id && e.type === 'arrived'))
    expect(h.events.some(e => e.type === 'fell' || e.type === 'failed')).toBe(false)
  })
  it('without a ladder under its feet, the same dig is refused', () => {
    const h = harness(shaft(false), undefined, 12)
    const id = h.run(c => c.units.spawn([5, 9, 5]))
    h.run(c => c.units.dig(id, [5, 8, 5]))
    h.until(() => h.events.some(e => e.unit === id && e.type !== 'arrived'), 20)
    expect(h.events.find(e => e.unit === id && e.type === 'failed')).toEqual({ unit: id, type: 'failed', reason: 'no-access' })
  })
})
