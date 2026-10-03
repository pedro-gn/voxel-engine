import { describe, expect, it } from 'vitest'
import { GenHost } from '../src/gen/genHost.ts'
import type { FromGen } from '../src/protocol.ts'
import { defineGenerator } from '../src/sim/generator.ts'
import { Simulation } from '../src/sim/simulation.ts'
import { testGenerator } from '../src/sim/testGenerator.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { TEST_BLOCKS } from './helpers.ts'

function setup(gen = testGenerator) {
  const out: { m: FromGen; transfer: Transferable[] }[] = []
  const host = new GenHost((m, transfer) => out.push({ m, transfer }), gen)
  return { host, out }
}
const configure = (epoch: number, doc?: unknown) =>
  ({ type: 'configure', epoch, doc, size: [64, 64, 64], seed: 5, blocks: TEST_BLOCKS }) as const

describe('GenHost', () => {
  it('generates the same column as the sim does, and transfers its buffer', () => {
    const { host, out } = setup()
    host.handle(configure(1))
    host.handle({ type: 'job', id: 7, cx: 1, cz: 0 })
    const r = out[0]!
    expect(r.m.type === 'column' && [r.m.id, r.m.epoch, r.m.cx, r.m.cz]).toEqual([7, 1, 1, 0])
    const sim = new Simulation({ buffers: createWorldBuffers([64, 64, 64]), blocks: TEST_BLOCKS, seed: 5 })
    const expected = new Uint16Array(32 * 32 * 64)
    sim.generateColumnData(testGenerator, 1, 0, expected)
    expect(r.m.type === 'column' && r.m.data).toEqual(expected)
    expect(r.transfer).toEqual([r.m.type === 'column' && r.m.data.buffer])
  })

  it('answers jobs with an error until configured', () => {
    const { host, out } = setup()
    host.handle({ type: 'job', id: 1, cx: 0, cz: 0 })
    expect(out[0]!.m).toEqual({ type: 'error', id: 1, epoch: -1, message: 'not configured' })
  })

  it('reports a rejected document on every job of that epoch, and recovers on the next configure', () => {
    let reject = true
    const gen = defineGenerator({
      configure() { if (reject) throw new Error('ops[2].type: unknown op type "x"') },
      generateColumn() {},
    })
    const { host, out } = setup(gen)
    host.handle(configure(3, {}))
    host.handle({ type: 'job', id: 1, cx: 0, cz: 0 })
    expect(out[0]!.m).toEqual({ type: 'error', id: 1, epoch: 3, message: 'Error: ops[2].type: unknown op type "x"' })
    reject = false
    host.handle(configure(4, {}))
    host.handle({ type: 'job', id: 2, cx: 0, cz: 0 })
    expect(out[1]!.m.type).toBe('column')
  })

  it('reports a column that throws', () => {
    const { host, out } = setup(defineGenerator({ generateColumn(_ctx, cx) { if (cx === 1) throw new RangeError('boom') } }))
    host.handle(configure(1))
    host.handle({ type: 'job', id: 9, cx: 1, cz: 0 })
    expect(out[0]!.m).toEqual({ type: 'error', id: 9, epoch: 1, message: 'RangeError: boom' })
  })
})
