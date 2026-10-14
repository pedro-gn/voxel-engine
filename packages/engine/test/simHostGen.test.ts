import { afterEach, describe, expect, it } from 'vitest'
import { defineGenerator } from '../src/sim/generator.ts'
import { testGenerator } from '../src/sim/testGenerator.ts'
import { closePorts, genPorts, makeHost, waitFor } from './genHelpers.ts'

afterEach(closePorts)
const settled = (out: Parameters<typeof waitFor>[0]) => waitFor(out, (m) => m.type === 'ready' || m.type === 'fatal')

describe('SimHost parallel generation', () => {
  it('builds the same world on generation workers as serially', async () => {
    const serial = makeHost(testGenerator)
    const parallel = makeHost(testGenerator, { genPorts: genPorts(3, testGenerator) })
    expect(parallel.out.some((m) => m.type === 'ready')).toBe(false) // waits for the workers
    await settled(parallel.out)
    const ready = parallel.out.find((m) => m.type === 'ready')
    expect(ready?.type === 'ready' && [ready.chunks.length, ready.columns]).toEqual([12, 6])
    expect(parallel.host.simulation!.hash()).toBe(serial.host.simulation!.hash())
  })

  it('inits the game systems before posting ready', async () => {
    const calls: string[] = []
    const { out } = makeHost(testGenerator, { genPorts: genPorts(2, testGenerator) }, [{ name: 'boot', version: 1, init: () => { calls.push(`init ${out.some(m => m.type === 'ready')}`) }, tick: () => {}, snapshot: () => null }])
    await settled(out)
    expect(out.some(m => m.type === 'ready')).toBe(true)
    expect(calls).toEqual(['init false'])
  })

  it('configures the workers with the terrain document', async () => {
    const seen: unknown[] = []
    const gen = defineGenerator({ configure(doc) { seen.push(doc) }, generateColumn() {} })
    const { out } = makeHost(gen, { terrain: { v: 1 }, genPorts: genPorts(2, gen) })
    await settled(out)
    expect(seen).toEqual([{ v: 1 }, { v: 1 }, { v: 1 }]) // the sim's own copy, then each worker
  })

  it('is fatal, naming the column, when a worker fails a column', async () => {
    const gen = defineGenerator({ generateColumn(_ctx, cx, cz) { if (cx === 2 && cz === 1) throw new Error('op "spire" failed') } })
    const { out } = makeHost(gen, { genPorts: genPorts(2, gen) })
    await settled(out)
    expect(out.at(-1)).toEqual({ type: 'fatal', message: 'Error: terrain generation failed at column (2, 1): Error: op "spire" failed' })
  })
})
