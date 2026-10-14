import { describe, expect, it } from 'vitest'
import type { FromSim } from '../src/protocol.ts'
import { defineGenerator } from '../src/sim/generator.ts'
import { SimHost, type Clock } from '../src/sim/simHost.ts'
import { defineSystem, type GameSystem } from '../src/sim/systems.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
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

  it('a throwing system tick posts fatal', () => {
    const { out, clock, host } = setup([{ name: 'boom', version: 1, tick() { throw new Error('x') }, snapshot: () => null }])
    clock.t = 50; host.pump()
    expect(out.find(m => m.type === 'fatal')).toMatchObject({ message: expect.stringContaining('system boom tick: x') })
  })
})
