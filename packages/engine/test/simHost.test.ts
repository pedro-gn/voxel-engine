import { describe, expect, it } from 'vitest'
import { defineGenerator } from '../src/sim/generator.ts'
import { defineRules } from '../src/sim/rules.ts'
import { SimHost, type Clock } from '../src/sim/simHost.ts'
import type { FromSim } from '../src/protocol.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'

const empty = defineGenerator({ generateColumn() {} })
function setup(options = {}, rules = defineRules({})) {
  const out: FromSim[] = []
  const clock = { t: 0, now() { return this.t }, setTimeout() { return 0 }, clearTimeout() {} } satisfies Clock & { t: number }
  const host = new SimHost((m) => out.push(m), { rules, generator: empty }, clock)
  host.handle({ type: 'init', buffers: createWorldBuffers([64, 64, 64]), blocks: TEST_BLOCKS, seed: 1, options })
  return { out, clock, host, ticks: () => out.filter((m) => m.type === 'tick') }
}

describe('SimHost', () => {
  it('generates and reports ready with every chunk', () => {
    const { out } = setup()
    const ready = out.find((m) => m.type === 'ready')
    expect(ready && ready.type === 'ready' && ready.chunks).toHaveLength(8)
  })
  it('ticks at a fixed 20 Hz step', () => {
    const { host, clock, ticks } = setup()
    host.handle({ type: 'start' })
    clock.t = 49; host.pump()
    expect(ticks()).toHaveLength(0)
    clock.t = 50; host.pump()
    expect(ticks()).toHaveLength(1)
    clock.t = 170; host.pump()
    expect(ticks()).toHaveLength(3)
  })
  it('runs at most 4 catch-up ticks and logs the dropped backlog', () => {
    const { host, clock, ticks, out } = setup()
    host.handle({ type: 'start' })
    clock.t = 1000; host.pump()
    expect(ticks()).toHaveLength(4)
    expect(out.some((m) => m.type === 'log' && /dropped 16 ticks/.test(m.message))).toBe(true)
    // the backlog is gone: the next wake-up one step later runs exactly one tick
    clock.t = 1050; host.pump()
    expect(ticks()).toHaveLength(5)
  })
  it('acks submitted commands on the next tick', () => {
    const { host, clock, ticks } = setup()
    host.handle({ type: 'start' })
    host.handle({ type: 'submit', clientId: 0, seq: 7, cmd: { type: 'setBlock', pos: [1, 1, 1], voxel: ID.stone } })
    clock.t = 50; host.pump()
    const t = ticks()[0]!
    expect(t.type === 'tick' && t.acks).toEqual([{ clientId: 0, seq: 7, ok: true }])
  })
  it('rejects non-integer clientId/seq with an ack error instead of passing them to the sim', () => {
    const { host, clock, ticks } = setup()
    host.handle({ type: 'start' })
    const cmd = { type: 'setBlock', pos: [1, 1, 1], voxel: ID.stone } as const
    host.handle({ type: 'submit', clientId: 0, seq: Number.NaN, cmd })
    host.handle({ type: 'submit', clientId: 1.5, seq: 1, cmd })
    host.handle({ type: 'submit', clientId: 0, seq: 2, cmd })
    clock.t = 50; host.pump()
    const t = ticks()[0]!
    if (t.type !== 'tick') throw new Error('expected tick')
    expect(t.acks).toHaveLength(3)
    expect(t.acks.filter((a) => !a.ok)).toHaveLength(2)
    expect(t.acks.find((a) => !a.ok)!.error).toMatch(/integer/)
    expect(t.acks.filter((a) => a.ok)).toEqual([{ clientId: 0, seq: 2, ok: true }])
  })
  it('turns WorldFullError into fatal with the slot count and stops ticking', () => {
    // 512 chunks, but only one 256-slot page allowed
    const out: FromSim[] = []
    const clock = { t: 0, now() { return this.t }, setTimeout() { return 0 }, clearTimeout() {} }
    const host = new SimHost((m) => out.push(m), { generator: empty }, clock)
    host.handle({ type: 'init', buffers: createWorldBuffers([512, 64, 512]), blocks: TEST_BLOCKS, seed: 1, options: { maxPages: 1 } })
    host.handle({ type: 'start' })
    let seq = 0
    for (let cz = 0; cz < 16; cz++) for (let cx = 0; cx < 16; cx++) for (let cy = 0; cy < 2; cy++) {
      host.handle({ type: 'submit', clientId: 0, seq: seq++, cmd: { type: 'setBlock', pos: [cx * 32, cy * 32, cz * 32], voxel: ID.stone } })
    }
    clock.t = 50; host.pump()
    const fatal = out.find((m) => m.type === 'fatal')
    expect(fatal && fatal.type === 'fatal' && fatal.message).toMatch(/world full/)
    expect(fatal && fatal.type === 'fatal' && fatal.slots).toBe(256)
    clock.t = 500; host.pump()
    expect(out.filter((m) => m.type === 'tick')).toHaveLength(0)
  })
  it('reports init failures as fatal', () => {
    const out: FromSim[] = []
    const host = new SimHost((m) => out.push(m), { rules: defineRules({ blocks: { nope: {} } }), generator: empty })
    host.handle({ type: 'init', buffers: createWorldBuffers([32, 32, 32]), blocks: TEST_BLOCKS, seed: 1, options: {} })
    expect(out.at(-1)).toMatchObject({ type: 'fatal' })
  })
  it('rejects a non-finite or non-positive tickHz as a fatal init error', () => {
    for (const tickHz of [0, -5, Number.NaN, Infinity]) {
      const out: FromSim[] = []
      const host = new SimHost((m) => out.push(m), { generator: empty })
      host.handle({ type: 'init', buffers: createWorldBuffers([32, 32, 32]), blocks: TEST_BLOCKS, seed: 1, options: { tickHz } })
      expect(out).toHaveLength(1)
      expect(out[0]).toMatchObject({ type: 'fatal', message: expect.stringMatching(/tickHz must be a finite number > 0/) })
    }
  })
  it('reports a generator crash as fatal with the error', () => {
    const out: FromSim[] = []
    const boom = defineGenerator({ generateColumn() { throw new Error('kaboom') } })
    const host = new SimHost((m) => out.push(m), { generator: boom })
    host.handle({ type: 'init', buffers: createWorldBuffers([32, 32, 32]), blocks: TEST_BLOCKS, seed: 1, options: {} })
    expect(out.at(-1)).toMatchObject({ type: 'fatal', message: expect.stringMatching(/kaboom/) })
  })
  it('stays dead after a failed init: start and submit never produce ticks', () => {
    const out: FromSim[] = []
    const clock = { t: 0, now() { return this.t }, setTimeout() { return 0 }, clearTimeout() {} }
    const boom = defineGenerator({ generateColumn() { throw new Error('kaboom') } })
    const host = new SimHost((m) => out.push(m), { generator: boom }, clock)
    host.handle({ type: 'init', buffers: createWorldBuffers([32, 32, 32]), blocks: TEST_BLOCKS, seed: 1, options: {} })
    host.handle({ type: 'start' })
    host.handle({ type: 'submit', clientId: 0, seq: 1, cmd: { type: 'setBlock', pos: [1, 1, 1], voxel: ID.stone } })
    clock.t = 200; host.pump()
    expect(out.filter((m) => m.type === 'tick')).toHaveLength(0)
  })
  it('stays dead after a mid-run fatal: a later start does not resume ticking', () => {
    const out: FromSim[] = []
    const clock = { t: 0, now() { return this.t }, setTimeout() { return 0 }, clearTimeout() {} }
    const host = new SimHost((m) => out.push(m), { generator: empty }, clock)
    host.handle({ type: 'init', buffers: createWorldBuffers([512, 64, 512]), blocks: TEST_BLOCKS, seed: 1, options: { maxPages: 1 } })
    host.handle({ type: 'start' })
    let seq = 0
    for (let cz = 0; cz < 16; cz++) for (let cx = 0; cx < 16; cx++) for (let cy = 0; cy < 2; cy++) {
      host.handle({ type: 'submit', clientId: 0, seq: seq++, cmd: { type: 'setBlock', pos: [cx * 32, cy * 32, cz * 32], voxel: ID.stone } })
    }
    clock.t = 50; host.pump()
    expect(out.some((m) => m.type === 'fatal')).toBe(true)
    host.handle({ type: 'start' })
    host.handle({ type: 'submit', clientId: 0, seq: 9999, cmd: { type: 'setBlock', pos: [1, 1, 1], voxel: ID.stone } })
    clock.t = 400; host.pump()
    expect(out.filter((m) => m.type === 'tick')).toHaveLength(0)
  })
  it('pauses and resumes physics on request', () => {
    const { host } = setup()
    host.handle({ type: 'setPaused', paused: true })
    expect(host.simulation!.paused).toBe(true)
    host.handle({ type: 'setPaused', paused: false })
    expect(host.simulation!.paused).toBe(false)
  })
  it('starts paused when init options say so, running otherwise', () => {
    expect(setup({ paused: true }).host.simulation!.paused).toBe(true)
    expect(setup().host.simulation!.paused).toBe(false)
  })
})
