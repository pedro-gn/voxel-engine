import { vi } from 'vitest'
import { GenHost } from '../src/gen/genHost.ts'
import type { FromSim, ToGen, ToSim } from '../src/protocol.ts'
import type { GeneratorModule } from '../src/sim/generator.ts'
import { SimHost, type Clock } from '../src/sim/simHost.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { TEST_BLOCKS } from './helpers.ts'

const open: MessagePort[] = []

/** Call from afterEach: open ports keep Node's event loop alive. */
export function closePorts(): void { for (const p of open.splice(0)) p.close() }

/** Real MessageChannels with a GenHost on the far end, as in the browser. */
export function genPorts(n: number, gen: GeneratorModule): MessagePort[] {
  return Array.from({ length: n }, () => {
    const ch = new MessageChannel()
    const host = new GenHost((m, transfer) => ch.port2.postMessage(m, transfer), gen)
    ch.port2.onmessage = (e: MessageEvent<ToGen>) => host.handle(e.data)
    open.push(ch.port1, ch.port2)
    return ch.port1
  })
}

/** A SimHost on a 96 × 64 × 64 world (3 × 2 chunk columns) with a manual clock. */
export function makeHost(gen: GeneratorModule, init: Partial<Extract<ToSim, { type: 'init' }>> = {}) {
  const out: FromSim[] = []
  const clock: Clock = { now: () => 0, setTimeout: () => 0, clearTimeout() {} }
  const host = new SimHost((m) => out.push(m), { generator: gen }, clock)
  host.handle({ type: 'init', buffers: createWorldBuffers([96, 64, 64]), blocks: TEST_BLOCKS, seed: 11, options: {}, ...init })
  return { host, out }
}

/** Resolves once a posted message matches. */
export function waitFor(out: FromSim[], match: (m: FromSim) => boolean): Promise<void> {
  return vi.waitFor(() => { if (!out.some(match)) throw new Error('waiting for the sim') }, { timeout: 5000 })
}
