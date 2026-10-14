import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import type { GameSystem, SystemContext } from '../src/sim/systems.ts'
import type { UnitEvent } from '../src/sim/workers/types.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'

/** A 16 × 16 stone island at y 10..11 in the middle of a 64² void world. */
function make(isVoid = true) {
  const events: UnitEvent[] = []
  let script: ((c: SystemContext) => void) | null = null
  const sys: GameSystem = { name: 't', version: 1, snapshot: () => null, tick: c => { events.push(...c.units.events); const s = script; script = null; s?.(c) } }
  const sim = new Simulation({ buffers: createWorldBuffers([64, 32, 64]), blocks: [{ name: 'stone' }], seed: 4, randomTicksPerChunk: 0, log: () => {}, systems: [sys], workers: { materials: { stone: { digTicks: 2, buildTicks: 2 } } } })
  const gen = { configure: () => (isVoid ? { void: true } : undefined), generateColumn(ctx: { set(x: number, y: number, z: number, v: number): void }, cx: number, cz: number) {
    for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) { const x = cx * 32 + lx, z = cz * 32 + lz; if (x >= 24 && x < 40 && z >= 24 && z < 40) { ctx.set(lx, 10, lz, 1); ctx.set(lx, 11, lz, 1) } } } }
  sim.configure(gen, null); sim.generate(gen); sim.step()
  const run = <T>(s: (c: SystemContext) => T): T => { let out!: T; script = c => { out = s(c) }; sim.step(); return out }
  return { sim, events, run }
}

describe('void world units', () => {
  it('a unit whose island is dug away falls out of the world and dies', () => {
    const h = make()
    const id = h.run(c => c.units.spawn([30, 12, 30]))
    const r = (() => { h.sim.submit(0, 1, { type: 'fillRegion', min: [24, 10, 24], max: [39, 11, 39], voxel: 0 }); return h.sim.step() })()
    expect(r.acks[0]?.ok).toBe(true)
    let died: unknown[] = []
    for (let i = 0; i < 200; i++) died = died.concat(h.sim.step().events.filter(e => e.type === 'unitDied'))
    expect(died).toEqual([expect.objectContaining({ type: 'unitDied', payload: { id, cause: 'void' } })])
    expect(h.events).toContainEqual({ unit: id, type: 'died', cause: 'void' })
    expect(h.sim.workers!.units.has(id)).toBe(false)
  })

  it('the bottom of the world is not ground to stand on, walk on or build against', () => {
    const h = make()
    expect(h.sim.workers!.nav.stand(5, 0, 5)).toBe(false)
    expect(make(false).sim.workers!.nav.stand(5, 0, 5)).toBe(true)
  })

  it('nothing is built against the bottom of a void world', () => {
    const h = make()
    const id = h.run(c => c.units.spawn([30, 12, 30]))
    h.run(c => c.units.build(id, [5, 0, 5], 1))
    h.sim.step()
    expect(h.events).toContainEqual({ unit: id, type: 'failed', reason: 'no-access' })
  })

  it('a route never leads off the island', () => {
    const h = make()
    const id = h.run(c => c.units.spawn([25, 12, 25]))
    h.run(c => c.units.goTo(id, [5, 0, 5]))
    for (let i = 0; i < 50; i++) h.sim.step()
    expect(h.events).toContainEqual({ unit: id, type: 'failed', reason: 'no-access' })
    expect(h.sim.workers!.units.has(id)).toBe(true)
  })
})
