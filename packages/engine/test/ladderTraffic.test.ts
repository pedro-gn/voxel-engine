import { describe, expect, it } from 'vitest'
import { ladderState } from '../src/blocks/shapes.ts'
import { Simulation } from '../src/sim/simulation.ts'
import type { GameSystem, SystemContext } from '../src/sim/systems.ts'
import type { UnitEvent } from '../src/sim/workers/types.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { packVoxel } from '../src/world/voxel.ts'

const blocks = [{ name: 'stone' }, { name: 'planks' }, { name: 'ladder', shape: 'ladder' as const, solid: false, climbable: true }]
const STONE = 1, LADDER = 3
type Gen = { set(x: number, y: number, z: number, v: number): void }
type Vec3 = [number, number, number]

/** A 32³ world, stone below y 4, `extra` drawn after it, and a test system recording unit events. */
function harness(extra: (g: Gen) => void) {
  const events: UnitEvent[] = []
  let script: ((c: SystemContext) => void) | null = null
  let ctx!: SystemContext
  const sys: GameSystem = { name: 'test', version: 1, snapshot: () => null, tick: c => { ctx = c; events.push(...c.units.events); const s = script; script = null; s?.(c) } }
  const sim = new Simulation({ buffers: createWorldBuffers([32, 32, 32]), blocks, seed: 1, randomTicksPerChunk: 0, log: () => {}, systems: [sys],
    workers: { materials: { stone: { digTicks: 4, buildTicks: 3 }, planks: { digTicks: 2, buildTicks: 3 }, ladder: { buildTicks: 3 } } } })
  sim.generate({ generateColumn(g) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) g.set(x, y, z, STONE); extra(g) } })
  sim.step()
  const run = <T>(s: (c: SystemContext) => T): T => { let out!: T; script = c => { out = s(c) }; sim.step(); return out }
  return { sim, events, run, get ctx() { return ctx } }
}
/** Two units head-on: a from `ap` to `ag`, b from `bp` to `bg`; the ids that arrived within `cap` ticks. */
function headOn(h: ReturnType<typeof harness>, ap: Vec3, ag: Vec3, bp: Vec3, bg: Vec3, cap = 3000) {
  const a = h.run(c => c.units.spawn(ap)), b = h.run(c => c.units.spawn(bp))
  h.run(c => { c.units.goTo(a, ag); c.units.goTo(b, bg) })
  const arrived = new Set<number>()
  for (let t = 0; t < cap && arrived.size < 2; t++) { h.sim.step(); for (const e of h.events) if (e.type === 'arrived') arrived.add(e.unit) }
  return { a, b, arrived }
}
/** Solid stone up to y 10, a 1 × 1 ladder shaft at (5, 4..10, 5) and a 1-wide dead-end tunnel x 6..8, z 5, y 4..5 at its foot. */
const mine = (g: Gen) => {
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 4; y <= 10; y++) g.set(x, y, z, STONE)
  for (let y = 4; y <= 10; y++) g.set(5, y, 5, packVoxel(LADDER, ladderState(0)))
  for (let x = 6; x <= 8; x++) for (let y = 4; y <= 5; y++) g.set(x, y, 5, 0)
}

describe('traffic on a ladder (mining review C1)', () => {
  it('two units meeting on a 1 × 1 shaft over a 1-wide dead-end tunnel both arrive: one backs off', () => {
    const h = harness(mine)
    const { arrived } = headOn(h, [7, 4, 5], [6, 11, 7], [6, 11, 6], [8, 4, 5])
    expect(h.events.filter(e => e.type === 'failed')).toEqual([])
    expect(arrived.size).toBe(2)
  })
  it('the same with the unit above already on the ladder when they meet', () => {
    const h = harness(mine)
    const a = h.run(c => c.units.spawn([7, 4, 5])), b = h.run(c => c.units.spawn([5, 9, 5]))
    h.run(c => { c.units.goTo(a, [6, 11, 7]); c.units.goTo(b, [8, 4, 5]) })
    const arrived = new Set<number>()
    for (let t = 0; t < 3000 && arrived.size < 2; t++) { h.sim.step(); for (const e of h.events) if (e.type === 'arrived') arrived.add(e.unit) }
    expect(h.events.filter(e => e.type === 'failed')).toEqual([])
    expect(arrived.size).toBe(2)
  })
  it('two units that cannot pass at all (one-wide both ends) do not wait forever: the one on the ladder fails "traffic"', () => {
    // The shaft's top opens only onto a one-wide corridor (x 6..8, z 5, y 11..12) and its foot onto the dead-end tunnel.
    const h = harness(g => {
      mine(g)
      for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 11; y <= 12; y++) g.set(x, y, z, STONE)
      for (let x = 5; x <= 8; x++) for (let y = 11; y <= 12; y++) g.set(x, y, 5, 0)
    })
    const { arrived } = headOn(h, [7, 4, 5], [8, 11, 5], [7, 11, 5], [8, 4, 5], 4000)
    expect(arrived.size).toBeLessThan(2)
    expect(h.events.filter(e => e.type === 'failed').map(e => (e as { reason?: string }).reason)).toContain('traffic')
  })
  it('control: the same meeting laid flat (a dead-end corridor) resolves', () => {
    const h = harness(g => {
      for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 4; y <= 5; y++) g.set(x, y, z, STONE)
      for (let x = 2; x <= 8; x++) for (let y = 4; y <= 5; y++) g.set(x, y, 5, 0)
      for (let x = 9; x <= 20; x++) for (let z = 0; z < 32; z++) for (let y = 4; y <= 5; y++) g.set(x, y, z, 0)
    })
    expect(headOn(h, [3, 4, 5], [15, 4, 10], [15, 4, 5], [2, 4, 5]).arrived.size).toBe(2)
  })
})
