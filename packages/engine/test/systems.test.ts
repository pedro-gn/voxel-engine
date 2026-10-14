import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import { defineSystem, type GameSystem, type SystemContext } from '../src/sim/systems.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'

const blocks = [{ name: 'stone' }, { name: 'dirt' }]
const floor = { generateColumn(ctx: { set(x: number, y: number, z: number, v: number): void }) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) ctx.set(x, y, z, 1) } }

function make(systems: GameSystem[], workers = true) {
  const sim = new Simulation({ buffers: createWorldBuffers([32, 32, 32]), blocks, seed: 3, randomTicksPerChunk: 0, log: () => {}, systems, ...(workers && { workers: { materials: { stone: { digTicks: 2, buildTicks: 2 } } } }) })
  sim.generate(floor)
  return sim
}
let seq = 0
function submit(sim: Simulation, cmd: { type: string; [k: string]: unknown }) { sim.submit(0, ++seq, cmd); return sim.step() }

describe('game systems', () => {
  it('inits once before the first tick, then ticks every step', () => {
    const calls: string[] = []
    const sim = make([defineSystem({ name: 'a', version: 1, init: c => calls.push(`init ${c.tick}`), tick: c => calls.push(`tick ${c.tick}`), snapshot: () => null })])
    sim.step(); sim.step()
    expect(calls).toEqual(['init 0', 'tick 0', 'tick 1'])
  })

  it('runs in list order and publishes into the tick result', () => {
    const order: string[] = []
    const sys = (name: string): GameSystem => ({ name, version: 1, tick: () => order.push(name), snapshot: () => null, publish: c => ({ at: c.tick }) })
    const sim = make([sys('b'), sys('a')])
    const r = sim.step()
    expect(order).toEqual(['b', 'a'])
    expect(r.systems).toEqual([{ name: 'b', payload: { at: 0 } }, { name: 'a', payload: { at: 0 } }])
  })

  it('omits undefined publications and the field when nothing is published', () => {
    const sim = make([{ name: 'a', version: 1, tick: () => {}, snapshot: () => null, publish: () => undefined }])
    expect(sim.step().systems).toBeUndefined()
  })

  it('routes name: commands to their system and acks them', () => {
    const got: unknown[] = []
    const sim = make([{ name: 'colony', version: 1, tick: () => {}, snapshot: () => null, command: (_c, cmd) => { got.push(cmd); if ((cmd as { bad?: boolean }).bad) throw new Error('no') } }])
    let r = submit(sim, { type: 'colony:hello', n: 1 })
    expect(r.acks[0]).toMatchObject({ ok: true })
    expect(got).toEqual([{ type: 'colony:hello', n: 1 }])
    r = submit(sim, { type: 'colony:hello', bad: true })
    expect(r.acks[0]).toMatchObject({ ok: false, error: 'no' })
    r = submit(sim, { type: 'other:hello' })
    expect(r.acks[0]).toMatchObject({ ok: false, error: 'unknown command type "other:hello"' })
  })

  it('refuses commands for a system without a command handler', () => {
    const sim = make([{ name: 'a', version: 1, tick: () => {}, snapshot: () => null }])
    expect(submit(sim, { type: 'a:x' }).acks[0]).toMatchObject({ ok: false, error: 'system a takes no commands' })
  })

  it('makes a throwing tick fatal, naming the system', () => {
    const sim = make([{ name: 'boom', version: 1, tick: () => { throw new Error('bad state') }, snapshot: () => null }])
    expect(() => sim.step()).toThrow('system boom tick: bad state')
  })

  it('validates names and refuses duplicates', () => {
    const s = (name: string): GameSystem => ({ name, version: 1, tick: () => {}, snapshot: () => null })
    expect(() => make([s('Bad Name')])).toThrow('invalid system name "Bad Name"')
    expect(() => make([s('a'), s('a')])).toThrow('duplicate system "a"')
    expect(() => make([{ ...s('a'), version: 0 }])).toThrow('system a: version must be an integer ≥ 1')
  })

  it('gives each system its own deterministic generator', () => {
    const draws = (seedName: string) => {
      const out: number[] = []
      const sim = make([{ name: seedName, version: 1, tick: c => { out.push(c.random()) }, snapshot: () => null }])
      sim.step(); sim.step()
      return out
    }
    expect(draws('a')).toEqual(draws('a'))
    expect(draws('a')).not.toEqual(draws('b'))
  })

  it('reads the world and edits it conditionally', () => {
    let ctx!: SystemContext
    const sim = make([{ name: 'a', version: 1, tick: c => { ctx = c }, snapshot: () => null }])
    sim.step()
    const stone = ctx.id('stone')
    expect(ctx.get(1, 3, 1)).toBe(stone)
    expect(ctx.isSolid(stone)).toBe(true)
    expect(ctx.edit([1, 3, 1], 0, ctx.id('dirt'))).toBe(false) // expected voxel differs
    expect(ctx.edit([1, 3, 1], stone, ctx.id('dirt'))).toBe(true)
    sim.step()
    expect(ctx.get(1, 3, 1)).toBe(ctx.id('dirt'))
  })

  it('does not tick while physics is paused', () => {
    let ticks = 0
    const sim = make([{ name: 'a', version: 1, tick: () => { ticks++ }, snapshot: () => null }])
    sim.setPaused(true); sim.step(); sim.step()
    sim.setPaused(false); sim.step()
    expect(ticks).toBe(1)
  })

  it('units are unavailable without workers', () => {
    let error = ''
    const sim = make([{ name: 'a', version: 1, tick: c => { try { c.units.spawn([1, 4, 1]) } catch (e) { error = (e as Error).message } }, snapshot: () => null }], false)
    sim.step()
    expect(error).toBe('this simulation runs without worker units')
  })
})
