import { describe, expect, it } from 'vitest'
import type { FromSim } from '../src/protocol.ts'
import { defineGenerator } from '../src/sim/generator.ts'
import { SimHost, type Clock } from '../src/sim/simHost.ts'
import { defineSystem, type GameSystem } from '../src/sim/systems.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { unpack } from '../src/persist/pack.ts'
import { TEST_BLOCKS } from './helpers.ts'

const empty = defineGenerator({ generateColumn() {} })
function setup(systems: GameSystem[]) {
  const out: FromSim[] = []
  const clock = { t: 0, now() { return this.t }, setTimeout() { return 0 }, clearTimeout() {} } satisfies Clock & { t: number }
  const host = new SimHost((m) => out.push(m), { generator: empty, systems }, clock)
  host.handle({ type: 'init', buffers: createWorldBuffers([64, 64, 64]), blocks: TEST_BLOCKS, seed: 1, options: {} })
  host.handle({ type: 'start' })
  return { out, clock, host }
}

describe('SimHost with systems', () => {
  it('posts publications with the tick and acks system commands', () => {
    let said = ''
    const sys = defineSystem<null, string>({ name: 'echo', version: 1, tick() {}, snapshot: () => null,
      command(_c, cmd) { said = String(cmd.text) }, publish: () => said || undefined })
    const { out, clock, host } = setup([sys as GameSystem])
    host.handle({ type: 'submit', clientId: 0, seq: 1, cmd: { type: 'echo:say', text: 'hi' } })
    clock.t = 50; host.pump()
    const ticks = out.filter((m): m is Extract<FromSim, { type: 'tick' }> => m.type === 'tick')
    const last = ticks.at(-1)!
    expect(last.acks).toContainEqual({ clientId: 0, seq: 1, ok: true })
    expect(last.systems).toEqual([{ name: 'echo', payload: 'hi' }])
  })

  it('a snapshot asked for right after ready, before any tick, holds the initialized system state', () => {
    let st = { inited: false }
    const sys = defineSystem<{ inited: boolean }, never>({ name: 'boot', version: 1, init() { st = { inited: true } }, restore(_c, s) { st = s }, tick() {}, snapshot: () => st })
    const { out, host } = setup([sys as GameSystem])
    expect(out.some(m => m.type === 'ready')).toBe(true)
    expect(out.some(m => m.type === 'tick')).toBe(false)
    host.handle({ type: 'snapshot', id: 1, since: null })
    const snap = out.find((m): m is Extract<FromSim, { type: 'snapshot'; ok: true }> => m.type === 'snapshot' && m.ok)!
    const section = snap.snapshot.sections.find(s => s.name === 'system:boot')!
    expect((unpack(section.bytes).json as { state: unknown }).state).toEqual({ inited: true })
  })

  it('a throwing init posts fatal at boot, before ready', () => {
    const { out } = setup([{ name: 'bad', version: 1, init() { throw new Error('no world for me') }, tick() {}, snapshot: () => null }])
    expect(out.some(m => m.type === 'ready')).toBe(false)
    expect(out.find(m => m.type === 'fatal')).toMatchObject({ message: expect.stringContaining('system bad init: no world for me') })
  })

  it('a throwing system tick posts fatal', () => {
    const { out, clock, host } = setup([{ name: 'boom', version: 1, tick() { throw new Error('x') }, snapshot: () => null }])
    clock.t = 50; host.pump()
    expect(out.find(m => m.type === 'fatal')).toMatchObject({ message: expect.stringContaining('system boom tick: x') })
  })
})
