import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import type { SimRestore, SimSnapshot } from '../src/sim/snapshot.ts'
import { defineSystem, type GameSystem } from '../src/sim/systems.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'

const blocks = [{ name: 'stone' }]
const floor = { generateColumn(ctx: { set(x: number, y: number, z: number, v: number): void }) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) ctx.set(x, 0, z, 1) } }

type Count = { n: number; draws: number[] }
const counter = (version = 1): GameSystem<Count> => {
  let st: Count = { n: 0, draws: [] }
  return defineSystem<Count, never>({
    name: 'counter', version,
    init() { st = { n: 0, draws: [] } },
    restore(_c, s) { st = { n: s.n, draws: [...s.draws] } },
    tick(c) { st.n++; st.draws.push(c.random()) },
    snapshot: () => ({ n: st.n, draws: [...st.draws] }),
  })
}

function sim(systems: GameSystem[]) {
  const s = new Simulation({ buffers: createWorldBuffers([32, 32, 32]), blocks, seed: 9, randomTicksPerChunk: 0, log: () => {}, systems })
  return s
}
function toRestore(s: SimSnapshot): SimRestore {
  return { tick: s.tick, paused: s.paused, regions: s.regions, sections: Object.fromEntries(s.sections.map(x => [x.name, x.bytes])) }
}

describe('system save sections', () => {
  it('saves the state and the generator; a loaded run continues identically', () => {
    const a = sim([counter()]); a.generate(floor)
    for (let i = 0; i < 5; i++) a.step()
    const snap = a.snapshot(null)
    expect(snap.sections.find(s => s.name === 'system:counter')).toMatchObject({ version: 1 })
    const b = sim([counter()]); b.restore(toRestore(snap))
    const c = sim([counter()]); c.restore(toRestore(snap))
    for (let i = 0; i < 5; i++) { a.step(); b.step(); c.step() }
    expect(b.hash()).toBe(a.hash())
    expect(b.snapshot(null).sections.find(s => s.name === 'system:counter')!.bytes).toEqual(a.snapshot(null).sections.find(s => s.name === 'system:counter')!.bytes)
  })

  it('a snapshot taken after start() but before the first tick keeps what init did', () => {
    let st = { n: -1 }
    const sys: GameSystem<{ n: number }> = { name: 'boot', version: 1, init: () => { st = { n: 42 } }, restore: (_c, s) => { st = { ...s } }, tick: () => {}, snapshot: () => st }
    const a = sim([sys]); a.generate(floor); a.systems!.start()
    const snap = toRestore(a.snapshot(null))
    st = { n: -1 }
    const b = sim([sys]); b.restore(snap); b.step()
    expect(st).toEqual({ n: 42 })
  })

  it('does not call init after a restore', () => {
    let inits = 0
    const sys: GameSystem = { name: 'x', version: 1, init: () => { inits++ }, tick: () => {}, snapshot: () => 1 }
    const a = sim([sys]); a.generate(floor); a.step()
    const b = sim([sys]); b.restore(toRestore(a.snapshot(null))); b.step()
    expect(inits).toBe(1)
  })

  it('refuses a save with a missing, unknown or other-version system section', () => {
    const a = sim([counter(1)]); a.generate(floor); a.step()
    const snap = toRestore(a.snapshot(null))
    expect(() => sim([counter(2)]).restore(snap)).toThrow('section system:counter v1, game expects v2')
    expect(() => sim([]).restore(snap)).toThrow(/^the save cannot be loaded by this game:\nsection system:counter is unknown to this game$/) // a sim without systems refuses them too
    const other: GameSystem = { name: 'other', version: 1, tick: () => {}, snapshot: () => null }
    expect(() => sim([other]).restore(snap)).toThrow(/section system:other is missing\nsection system:counter is unknown to this game/)
  })
})
