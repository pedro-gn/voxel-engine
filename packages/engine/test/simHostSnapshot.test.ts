import { describe, expect, it } from 'vitest'
import type { FromSim, ToSim } from '../src/protocol.ts'
import { SimHost, type Clock } from '../src/sim/simHost.ts'
import { testGenerator } from '../src/sim/testGenerator.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { TEST_BLOCKS } from './helpers.ts'

type Snap = Extract<FromSim, { type: 'snapshot'; ok: true }>
function host() {
  const out: FromSim[] = [], transfers: Transferable[][] = []
  const clock = { now: () => 0, setTimeout: () => 0, clearTimeout: () => {} } satisfies Clock
  const h = new SimHost((m, t) => { out.push(m); transfers.push(t ?? []) }, { generator: testGenerator }, clock)
  return { h, out, transfers }
}
const init = (extra: Partial<Extract<ToSim, { type: 'init' }>> = {}): ToSim => ({ type: 'init', buffers: createWorldBuffers([64, 32, 64]), blocks: TEST_BLOCKS, seed: 3, options: { randomTicksPerChunk: 0 }, ...extra })

describe('sim host snapshots', () => {
  it('answers a snapshot between ticks, transferring its buffers, and boots a second host from it', () => {
    const a = host()
    a.h.handle(init())
    a.h.handle({ type: 'submit', clientId: 0, seq: 1, cmd: { type: 'setBlock', pos: [3, 30, 3], voxel: 1 } })
    for (let i = 0; i < 5; i++) a.h.simulation!.step()
    a.h.handle({ type: 'snapshot', id: 7, since: null })
    const at = a.out.findIndex(m => m.type === 'snapshot')
    const snap = a.out[at] as Snap
    expect(snap.ok).toBe(true)
    expect(snap.id).toBe(7)
    expect(a.transfers[at]!.length).toBe(snap.snapshot.regions.length + snap.snapshot.sections.length + 1)
    const b = host()
    b.h.handle(init({ restore: { tick: snap.snapshot.tick, paused: snap.snapshot.paused, regions: snap.snapshot.regions, sections: Object.fromEntries(snap.snapshot.sections.map(s => [s.name, s.bytes])) } }))
    const ready = b.out.find(m => m.type === 'ready')
    expect(ready && ready.type === 'ready' && ready.chunks.length).toBe(a.h.simulation!.layout.chunkCount)
    expect(b.h.simulation!.tick).toBe(a.h.simulation!.tick)
    expect(b.h.simulation!.store.getVoxel(3, 30, 3)).toBe(1)
  })
  it('refuses a snapshot before the world is ready', () => {
    const a = host()
    a.h.handle({ type: 'snapshot', id: 1, since: null })
    expect(a.out).toEqual([{ type: 'snapshot', id: 1, ok: false, message: 'the world is not ready' }])
  })
})
