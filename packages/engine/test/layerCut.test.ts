import { describe, expect, it } from 'vitest'
import { LayerCut } from '../src/render/layerCut.ts'
import { MeshQueue, PRIORITY } from '../src/render/meshQueue.ts'
import { Layout } from '../src/world/layout.ts'

const L = new Layout([64, 96, 64]) // 2 × 3 × 2 chunks
const ci = (cx: number, cy: number, cz: number) => L.chunkIndex(cx, cy, cz)

describe('LayerCut', () => {
  it('hides chunks above the cut and crosses the cut layer', () => {
    const c = new LayerCut(L)
    const remesh = c.set(40)
    expect(c.hides(ci(0, 2, 0))).toBe(true)
    expect(c.crosses(ci(0, 1, 0))).toBe(true)
    expect(c.hides(ci(0, 1, 0))).toBe(false)
    expect(c.crosses(ci(0, 0, 0))).toBe(false)
    expect(remesh.sort()).toEqual([ci(0, 1, 0), ci(1, 1, 0), ci(0, 1, 1), ci(1, 1, 1)].sort())
    expect(c.top).toBe(41)
  })

  it('moving the cut to another layer remeshes both layers; null restores everything', () => {
    const c = new LayerCut(L)
    c.set(40)
    expect(c.set(70).length).toBe(8)
    expect(c.set(null).length).toBe(4)
    expect(c.hides(ci(0, 2, 0))).toBe(false)
    expect(c.top).toBe(Infinity)
  })

  it('stale cut results are dropped and re-queued', () => {
    const c = new LayerCut(L)
    c.set(40)
    expect(c.expected(ci(0, 1, 0))).toBe(40)
    c.set(41)
    expect(c.expected(ci(0, 1, 0))).toBe(41) // a result meshed with cut 40 no longer matches
    expect(c.expected(ci(0, 0, 0))).toBeUndefined()
  })

  it('setting the same cut again remeshes nothing', () => {
    const c = new LayerCut(L)
    expect(c.set(40).length).toBe(4)
    expect(c.set(40)).toEqual([])
    expect(c.set(null).length).toBe(4)
    expect(c.set(null)).toEqual([])
  })

  it('a result meshed for a cut that has moved on is refused; set() already queued its chunk again', () => {
    // The engine's flow (engine.ts dispatch/onMeshMessage/upload) over a MeshQueue: cut() marks, dispatch sends
    // expected(ci) with the job, the result echoes it, upload keeps it only if accepts(ci, cut).
    const c = new LayerCut(L), q = new MeshQueue(), crossed = ci(0, 1, 0), low = ci(0, 0, 0)
    for (const k of c.set(40)) q.mark(k, PRIORITY.CUT)
    q.mark(low, PRIORITY.DIRTY)
    const jobs = new Map<number, number | undefined>()
    for (let k = q.next(() => 0); k >= 0; k = q.next(() => 0)) jobs.set(k, c.expected(k))
    expect(jobs.get(crossed)).toBe(40)
    // The cut moves while the job is in flight: the chunk is marked again behind it.
    for (const k of c.set(41)) q.mark(k, PRIORITY.CUT)
    q.finish(crossed) // its stale result arrives
    expect(c.accepts(crossed, jobs.get(crossed))).toBe(false)
    expect(q.priorityOf(crossed)).toBe(PRIORITY.CUT) // queued again by set(), not by the drop
    // The cut is cleared after a result arrived but before upload took it: marked again directly.
    const next = q.next(() => 0)
    expect(next).toBeGreaterThanOrEqual(0)
    const sent = c.expected(next)
    q.finish(next)
    for (const k of c.set(null)) q.mark(k, PRIORITY.CUT)
    expect(c.accepts(next, sent)).toBe(false)
    expect(q.priorityOf(next)).toBe(PRIORITY.CUT)
    // A chunk the cut never crossed meshes without one, and is kept.
    expect(c.accepts(low, jobs.get(low))).toBe(true)
  })

  it('rejects heights outside the world', () => {
    const c = new LayerCut(L)
    expect(() => c.set(-1)).toThrow(RangeError)
    expect(() => c.set(96)).toThrow(RangeError)
    expect(() => c.set(1.5)).toThrow(RangeError)
  })
})
