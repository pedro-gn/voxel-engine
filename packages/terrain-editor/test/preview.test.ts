import { describe, expect, it } from 'vitest'
import type { TerrainDoc } from '@elovox/terrain'
import type { AreaRect } from '../src/core/area.ts'
import { setParam, setSeaLevel } from '../src/core/edits.ts'
import { PreviewScheduler, type PreviewStatus, type TerrainTarget } from '../src/core/preview.ts'
import type { ChangeEvent } from '../src/core/session.ts'
import { SIZE, doc } from './fixtures.ts'

type Call = ['set', TerrainDoc] | ['regen', AreaRect]

function fake() {
  const calls: Call[] = []
  const waiting: { resolve: () => void; reject: (e: Error) => void }[] = []
  const target: TerrainTarget = {
    setDocument(d) { calls.push(['set', d as TerrainDoc]); return Promise.resolve() },
    regenerate(rect) {
      calls.push(['regen', rect])
      return new Promise((res, rej) => waiting.push({ resolve: () => res({ ms: 5, chunks: 3 }), reject: rej }))
    },
  }
  return { target, calls, waiting }
}
const tick = () => new Promise((r) => setTimeout(r, 0))
const A: AreaRect = { x0: 0, z0: 0, x1: 32, z1: 32 }
const B: AreaRect = { x0: 64, z0: 64, x1: 96, z1: 96 }
const C: AreaRect = { x0: 128, z0: 0, x1: 160, z1: 32 }
const ev = (d: TerrainDoc, area: ChangeEvent['area'], cause: ChangeEvent['cause']): ChangeEvent => ({ doc: d, prev: d, area, cause })

function setup(settle?: () => Promise<void>) {
  const f = fake()
  const statuses: PreviewStatus[] = []
  const start = doc()
  const p = new PreviewScheduler(f.target, start, { size: SIZE, settle, onStatus: (s) => statuses.push(s), now: () => 0 })
  return { ...f, p, start, statuses }
}

describe('PreviewScheduler', () => {
  it('sends the new document, then regenerates the area', async () => {
    const { p, start, calls, waiting } = setup()
    const d1 = setParam('hill', 'amplitude', 3)(start)
    p.onChange(ev(d1, A, 'edit'))
    await tick()
    expect(calls).toEqual([['set', d1], ['regen', A]])
    waiting[0]!.resolve()
    await p.idle()
    expect(p.status).toEqual({ state: 'idle', last: { ms: 5, chunks: 3, wallMs: 0 } })
  })

  it('keeps one regeneration in flight and merges what arrives meanwhile, latest document first', async () => {
    const { p, start, calls, waiting } = setup()
    const d1 = setParam('hill', 'amplitude', 3)(start), d2 = setParam('hill', 'amplitude', 4)(start), d3 = setParam('hill', 'amplitude', 5)(start)
    p.onChange(ev(d1, A, 'gesture'))
    p.onChange(ev(d2, B, 'gesture'))
    p.onChange(ev(d3, C, 'gesture'))
    await tick()
    expect(calls).toHaveLength(2)
    waiting[0]!.resolve()
    await tick()
    expect(calls.slice(2)).toEqual([['set', d3], ['regen', { x0: 64, z0: 0, x1: 160, z1: 96 }]])
    waiting[1]!.resolve()
    await p.idle()
  })

  it('skips setDocument when the engine already has the document', async () => {
    const { p, start, calls, waiting } = setup()
    p.push(start, A)
    await tick()
    expect(calls).toEqual([['regen', A]])
    waiting[0]!.resolve()
    await p.idle()
  })

  it('ignores changes without an area and op-gesture commits', async () => {
    const { p, start, calls } = setup()
    p.onChange(ev(start, null, 'edit'))
    p.onChange(ev(setParam('hill', 'amplitude', 3)(start), A, 'commit'))
    await tick()
    expect(calls).toEqual([])
  })

  it('holds a whole-world gesture until it is committed', async () => {
    const { p, start, calls, waiting } = setup()
    const d1 = setSeaLevel(12)(start), d2 = setSeaLevel(13)(start)
    p.onChange(ev(d1, 'all', 'gesture'))
    p.onChange(ev(d2, 'all', 'gesture'))
    await tick()
    expect(calls).toEqual([])
    p.onChange(ev(d2, 'all', 'commit'))
    await tick()
    expect(calls).toEqual([['set', d2], ['regen', { x0: 0, z0: 0, x1: SIZE[0], z1: SIZE[1] }]])
    waiting[0]!.resolve()
    await p.idle()
  })

  it('drops a cancelled whole-world gesture', async () => {
    const { p, start, calls } = setup()
    p.onChange(ev(setSeaLevel(12)(start), 'all', 'gesture'))
    p.onChange(ev(start, 'all', 'cancel'))
    await tick()
    expect(calls).toEqual([])
  })

  it('reports a failing op and retries its area with the next edit', async () => {
    const { p, start, calls, waiting, statuses } = setup()
    p.push(setParam('hill', 'amplitude', 3)(start), A)
    await tick()
    waiting[0]!.reject(new Error('op "hill" failed at columns x 0..32, z 0..32: boom'))
    await p.idle()
    expect(p.status).toEqual({ state: 'error', message: 'op "hill" failed at columns x 0..32, z 0..32: boom', opId: 'hill' })
    p.push(setParam('hill', 'amplitude', 4)(start), B)
    await tick()
    expect(calls.at(-1)).toEqual(['regen', { x0: 0, z0: 0, x1: 96, z1: 96 }])
    waiting[1]!.resolve()
    await p.idle()
    expect(statuses.at(-1)!.state).toBe('idle')
  })

  it('stays busy until the meshes settle, then reports the wall time', async () => {
    let settled!: () => void
    const { p, start, waiting } = setup(() => new Promise<void>((r) => { settled = r }))
    p.push(setParam('hill', 'amplitude', 3)(start), A)
    await tick()
    waiting[0]!.resolve()
    await p.idle()
    expect(p.status.state).toBe('busy')
    settled()
    await tick()
    expect(p.status.state).toBe('idle')
  })

  it('ends the busy state even if settle rejects', async () => {
    const { p, start, waiting } = setup(() => Promise.reject(new Error('settle failed')))
    p.push(setParam('hill', 'amplitude', 3)(start), A)
    await tick()
    waiting[0]!.resolve()
    await p.idle()
    await tick()
    expect(p.status.state).toBe('idle')
    expect(p.status).toEqual({ state: 'idle', last: { ms: 5, chunks: 3, wallMs: 0 } })
  })

  it('regenerates with the pre-gesture document while a whole-world gesture is deferred and then cancelled', async () => {
    const { p, start, calls, waiting } = setup()
    const d1 = setParam('hill', 'amplitude', 3)(start), d2 = setParam('hill', 'amplitude', 4)(start)
    const sea = setSeaLevel(12)(d2)
    p.onChange(ev(d1, A, 'edit'))
    await tick() // d1 in flight
    p.onChange(ev(d2, B, 'edit')) // queued behind it
    p.onChange(ev(sea, 'all', 'gesture'))
    p.onChange(ev(d2, 'all', 'cancel'))
    waiting[0]!.resolve()
    await tick()
    const sent = calls.filter((c) => c[0] === 'set').map((c) => c[1])
    expect(sent).not.toContain(sea)
    expect(sent[sent.length - 1]).toBe(d2)
  })

  it('sends the pre-gesture document if the queued regeneration runs mid-gesture', async () => {
    const { p, start, calls, waiting } = setup()
    const d1 = setParam('hill', 'amplitude', 3)(start), d2 = setParam('hill', 'amplitude', 4)(start)
    p.onChange(ev(d1, A, 'edit'))
    await tick()
    p.onChange(ev(d2, B, 'edit'))
    p.onChange(ev(setSeaLevel(12)(d2), 'all', 'gesture'))
    waiting[0]!.resolve()
    await tick()
    expect(calls.slice(2)).toEqual([['set', d2], ['regen', B]])
  })
})
