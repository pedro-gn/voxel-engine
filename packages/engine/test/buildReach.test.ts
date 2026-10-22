import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import type { SimSnapshot } from '../src/sim/snapshot.ts'
import type { GameSystem, SystemContext } from '../src/sim/systems.ts'
import type { UnitEvent, WorkerOptions } from '../src/sim/workers/types.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { toRestore } from './persistHelpers.ts'

/** stone 1, planks 2 (solid), cloth 3 (non-solid, built only: a bed), moss 4 (non-solid). */
const blocks = [{ name: 'stone' }, { name: 'planks' }, { name: 'cloth', solid: false }, { name: 'moss', solid: false }]
const STONE = 1, PLANKS = 2, CLOTH = 3
type Gen = { set(x: number, y: number, z: number, v: number): void }
const MATERIALS: WorkerOptions['materials'] = { stone: { digTicks: 4, buildTicks: 3 }, planks: { digTicks: 2, buildTicks: 3 }, cloth: { buildTicks: 3 } }

/** A 32³ world with a stone floor (y < 4; units stand at y 4) and a system that records unit events and runs one script per tick. */
function harness(extra?: (g: Gen) => void, opts: Partial<WorkerOptions> = {}, from?: SimSnapshot) {
  const events: UnitEvent[] = []
  let script: ((c: SystemContext) => void) | null = null
  let ctx!: SystemContext
  const sys: GameSystem = { name: 'test', version: 1, snapshot: () => null, tick: c => { ctx = c; events.push(...c.units.events); const s = script; script = null; s?.(c) } }
  const sim = new Simulation({ buffers: createWorldBuffers([32, 32, 32]), blocks, seed: 1, randomTicksPerChunk: 0, log: () => {}, systems: [sys], workers: { materials: MATERIALS, ...opts } })
  if (from) sim.restore(toRestore(from))
  else sim.generate({ generateColumn(g) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) g.set(x, y, z, STONE); extra?.(g) } })
  sim.step()
  const run = <T>(s: (c: SystemContext) => T): T => { let out!: T; script = c => { out = s(c) }; sim.step(); return out }
  const until = (pred: () => boolean, cap = 800) => { for (let i = 0; i < cap && !pred(); i++) sim.step(); expect(pred()).toBe(true) }
  return { sim, events, run, until, get ctx() { return ctx } }
}
/** A stone pillar at (10, 4..top, 10): the target above it, at (10, top + 1, 10), rests on it. */
const pillar = (top: number) => (g: Gen) => { for (let y = 4; y <= top; y++) g.set(10, y, 10, STONE) }
/** The unit's own build event (built or failed), once it comes. */
const outcome = (h: ReturnType<typeof harness>, id: number) => {
  h.until(() => h.events.some(e => e.unit === id && (e.type === 'built' || e.type === 'failed')))
  return h.events.find(e => e.unit === id && (e.type === 'built' || e.type === 'failed'))!
}

describe('non-solid buildables and build reach', () => {
  it('a non-solid material with buildTicks is built like any other, and stays walkable', () => {
    const h = harness()
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.build(id, [10, 4, 10], CLOTH))
    expect(outcome(h, id)).toEqual({ unit: id, type: 'built', pos: [10, 4, 10], voxel: CLOTH })
    expect(h.sim.store.getVoxel(10, 4, 10)).toBe(CLOTH)
    h.run(c => c.units.goTo(id, [10, 4, 10])) // into the cell, as into a bush
    h.until(() => h.events.some(e => e.unit === id && e.type === 'arrived'))
    const v = h.ctx.units.view(id)!
    expect([v.x256 >> 8, v.y256 >> 8, v.z256 >> 8]).toEqual([10, 4, 10])
  })

  it('a non-solid material with digTicks is still refused, and so is one used as a route floor', () => {
    expect(() => harness(undefined, { materials: { ...MATERIALS, moss: { digTicks: 3 } } })).toThrow('work material moss must be solid')
    expect(() => harness(undefined, { materials: { ...MATERIALS, moss: { buildTicks: 3, digTicks: 3 } } })).toThrow('work material moss must be solid')
    const h = harness()
    h.sim.submit(0, 1, { type: 'unitSpawn', pos: [5, 4, 5] }); h.sim.step()
    const plain = [...h.sim.workers!.units.keys()][0]!
    h.sim.submit(0, 2, { type: 'unitMove', ids: [plain], pos: [9, 4, 9], buildBlock: CLOTH })
    expect(h.sim.step().acks[0]).toMatchObject({ ok: false, error: 'invalid route build material' })
  })

  it('buildReach 3: feet + 2 and feet + 3 are built from the ground, feet + 4 fails with no-access', () => {
    for (const [top, expected] of [[5, 'built'], [6, 'built'], [7, 'failed']] as const) {
      const h = harness(pillar(top), { buildReach: 3 })
      const id = h.run(c => c.units.spawn([5, 4, 5]))
      h.run(c => c.units.build(id, [10, top + 1, 10], PLANKS))
      const e = outcome(h, id)
      expect(e).toMatchObject({ type: expected })
      if (expected === 'failed') expect(e).toMatchObject({ reason: 'no-access' })
      expect(h.sim.store.getVoxel(10, top + 1, 10)).toBe(expected === 'built' ? PLANKS : 0)
    }
  })

  it('buildReach 3: a ceiling cell boxed in on all four sides is closed from straight below', () => {
    // The last cell of a roof: planks on its four sides at y 7, air below it down to the floor; only (10, 4, 10) reaches it.
    const h = harness(g => { for (const [x, z] of [[9, 10], [11, 10], [10, 9], [10, 11]] as const) for (let y = 4; y <= 7; y++) g.set(x, y, z, STONE) }, { buildReach: 3 })
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.sim.submit(0, 1, { type: 'setBlock', pos: [10, 4, 9], voxel: 0 }); h.sim.step() // a door into the cell below
    h.sim.submit(0, 2, { type: 'setBlock', pos: [10, 5, 9], voxel: 0 }); h.sim.step()
    h.run(c => c.units.build(id, [10, 7, 10], PLANKS))
    expect(outcome(h, id)).toMatchObject({ type: 'built', pos: [10, 7, 10] })
    expect(h.sim.store.getVoxel(10, 7, 10)).toBe(PLANKS)
  })

  it('buildReach 3: a solid cell between the head and the target blocks the reach', () => {
    // Above the only work pose's head, at y 6, a stone slab: (10, 7, 10) on its pillar cannot be reached past it.
    const h = harness(g => { pillar(6)(g); for (const [x, z] of [[9, 10], [11, 10], [10, 9], [10, 11]] as const) g.set(x, 6, z, STONE) }, { buildReach: 3 })
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.build(id, [10, 7, 10], PLANKS))
    expect(outcome(h, id)).toMatchObject({ type: 'failed', reason: 'no-access' })
  })

  it('without buildReach, feet + 2 fails with no-access as before', () => {
    const h = harness(pillar(5))
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.build(id, [10, 6, 10], PLANKS))
    expect(outcome(h, id)).toEqual({ unit: id, type: 'failed', reason: 'no-access' })
    expect(h.sim.store.getVoxel(10, 6, 10)).toBe(0)
  })

  it('a unit standing in the target cell: a non-solid build behaves as a solid one, and never lands on a unit', () => {
    const trace = (voxel: number, opts: Partial<WorkerOptions>) => {
      const h = harness(undefined, opts)
      const id = h.run(c => c.units.spawn([5, 4, 5]))
      h.run(c => c.units.spawn([10, 4, 10])) // stands idle in the target cell
      h.run(c => c.units.build(id, [10, 4, 10], voxel))
      for (let i = 0; i < 400; i++) {
        h.sim.step()
        if (h.sim.store.getVoxel(10, 4, 10) !== 0) expect(h.sim.workers!.overlaps(10, 4, 10)).toBe(false)
      }
      return { events: h.events.filter(e => e.unit === id).map(e => ({ ...e, ...('voxel' in e && { voxel: 0 }) })), placed: h.sim.store.getVoxel(10, 4, 10) !== 0 }
    }
    const today = trace(PLANKS, {}), solid = trace(PLANKS, { buildReach: 3 }), soft = trace(CLOTH, { buildReach: 3 })
    expect(soft).toEqual(solid)
    expect(solid).toEqual(today)
    expect(today).toEqual(PINNED)
  })

  it('a build at feet + 3 survives a save', () => {
    const h = harness(pillar(6), { buildReach: 3 })
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.build(id, [10, 7, 10], PLANKS))
    h.until(() => h.sim.workers!.view(id)!.state === 'working') // mid-build: at its work pose, the block under way
    expect(h.ctx.units.view(id)!.intent).toMatchObject({ kind: 'build' })
    expect(h.sim.store.getVoxel(10, 7, 10)).toBe(0)
    const r = harness(undefined, { buildReach: 3 }, h.sim.snapshot(null))
    expect(outcome(r, id)).toEqual({ unit: id, type: 'built', pos: [10, 7, 10], voxel: PLANKS })
    expect(r.sim.store.getVoxel(10, 7, 10)).toBe(PLANKS)
  })

  it('a build can carry its own reach: feet + 4 with { reach: 4 }, then plain builds are limited to buildReach again', () => {
    const pillars = (g: Gen) => { pillar(7)(g); for (let y = 4; y <= 7; y++) g.set(14, y, 10, STONE) }
    const h = harness(pillars, { buildReach: 3 })
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.build(id, [10, 8, 10], PLANKS, { reach: 4 }))
    expect(outcome(h, id)).toEqual({ unit: id, type: 'built', pos: [10, 8, 10], voxel: PLANKS })
    h.events.length = 0
    h.run(c => c.units.build(id, [14, 8, 10], PLANKS))
    expect(outcome(h, id)).toMatchObject({ type: 'failed', reason: 'no-access' })
    expect(h.sim.store.getVoxel(14, 8, 10)).toBe(0)
  })

  it('a reach of its own survives a save', () => {
    const h = harness(pillar(7), { buildReach: 3 })
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.build(id, [10, 8, 10], PLANKS, { reach: 4 }))
    h.until(() => h.sim.workers!.view(id)!.state === 'working')
    const r = harness(undefined, { buildReach: 3 }, h.sim.snapshot(null))
    expect(outcome(r, id)).toEqual({ unit: id, type: 'built', pos: [10, 8, 10], voxel: PLANKS })
  })

  it('a build intent\'s reach is part of the state hash', () => {
    const h = harness(pillar(7), { buildReach: 3 })
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.build(id, [10, 8, 10], PLANKS, { reach: 4 }))
    const units = (h.sim.workers as unknown as { units: Map<number, { intent: { reach?: number } }> }).units
    const before = h.sim.hash()
    units.get(id)!.intent.reach = 5
    expect(h.sim.hash()).not.toBe(before)
    units.get(id)!.intent.reach = 4
    expect(h.sim.hash()).toBe(before)
  })

  it('a save with a bad reach is refused on restore', () => {
    const h = harness(pillar(7), { buildReach: 3 })
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    h.run(c => c.units.build(id, [10, 8, 10], PLANKS, { reach: 4 }))
    for (const reach of [0, 17, 2.5, '4']) {
      const snap = structuredClone(h.sim.workers!.snapshot())
      ;(snap.units.find(u => u.id === id)!.intent as { reach?: unknown }).reach = reach
      const r = harness(pillar(7), { buildReach: 3 })
      expect(() => r.sim.workers!.restore(snap)).toThrow('build reach must be an integer 1..16')
    }
    // the same save with its good reach restores
    const r = harness(pillar(7), { buildReach: 3 })
    expect(() => r.sim.workers!.restore(structuredClone(h.sim.workers!.snapshot()))).not.toThrow()
  })

  it('refuses a reach outside 1..16', () => {
    const h = harness(pillar(7), { buildReach: 3 })
    const id = h.run(c => c.units.spawn([5, 4, 5]))
    for (const reach of [0, 17, 2.5]) {
      expect(() => h.run(c => c.units.build(id, [10, 8, 10], PLANKS, { reach }))).toThrow('build reach must be an integer 1..16')
      expect(() => h.sim.workers!.work(id, 'build', [10, 8, 10], PLANKS, reach)).toThrow(RangeError)
    }
  })
})

/** A solid build onto a unit standing idle in the cell (the path unchanged since 99558af): it fails with traffic at the commit, nothing placed. */
const PINNED = { events: [{ unit: 1, type: 'failed', reason: 'traffic' }], placed: false }
