import { describe, expect, it } from 'vitest'
import { SurfaceView } from '../src/render/water/surfaceView.ts'
import { WaterHost, type WaterReply, type WaterRequest } from '../src/render/water/waterHost.ts'
import { WaterLink } from '../src/render/water/waterLink.ts'
import { SurfaceMirror } from '../src/render/water/surfaceMirror.ts'
import { WaterPublisher, type WaterTick } from '../src/sim/water/publish.ts'
import { gateWorld } from './layerHelpers.ts'

const tickOf = (seq: number): WaterTick => ({ seq, parity: seq & 1, tiles: [], layers: null })
const reply = (req: WaterRequest, applied: boolean): WaterReply => ({ type: 'result', id: req.id, tick: req.tick, applied, hostMs: 0, keys: new Int32Array(), data: new Float32Array() })

/** A link over a fake host: requests wait until `answer` replies to them; `log` records the hooks in order. */
function fake(onScreen = { v: 0.6 }) {
  const posted: WaterRequest[] = [], log: string[] = []
  const link = new WaterLink({
    post: (req) => { posted.push(req); log.push(`post ${req.tick} @${req.shown}`) },
    copy: (r, publish) => log.push(`copy ${r.tick}${publish ? '' : ' (no publish)'}`),
    applied: (tick, arrived) => { onScreen.v = 0; log.push(`applied ${tick} from ${arrived}`) },
    settled: () => log.push('settled'),
    shown: () => onScreen.v,
  })
  return { link, posted, log, answer: (i: number, applied = true) => link.receive(reply(posted[i]!, applied)) }
}

describe('WaterLink (4a-r2 #2, spec 4.1)', () => {
  it('two publishes before the first reply: one in flight, the second sent after the first copy, at alpha 0, in order', () => {
    const { link, posted, log, answer } = fake()
    link.submit(1, tickOf(1), [], true, 100)
    link.submit(2, tickOf(2), [], true, 120)
    expect(posted.map(p => p.tick)).toEqual([1])
    expect([link.depth, link.frozen]).toEqual([2, 0.6])
    answer(0)
    expect(posted.map(p => p.tick)).toEqual([1, 2])
    expect([link.depth, link.frozen]).toEqual([1, 0])
    answer(1)
    expect([link.depth, link.frozen, link.maxDepth()]).toEqual([0, null, 2])
    expect(log).toEqual(['post 1 @0.6', 'copy 1', 'applied 1 from 100', 'post 2 @0', 'copy 2', 'applied 2 from 120'])
  })

  it('ticks without a publish release the clock in order, behind the request in flight', () => {
    const { link, log, answer } = fake()
    link.submit(1, tickOf(1), [], true, 0)
    link.submit(2, null, [], true, 0)
    link.submit(3, null, [], true, 0)
    expect(log).toEqual(['post 1 @0.6'])
    answer(0)
    expect(log).toEqual(['post 1 @0.6', 'copy 1', 'applied 1 from 0', 'settled', 'settled'])
    link.submit(4, null, [], true, 0)
    expect(log.at(-1)).toBe('settled') // nothing in flight: at once
  })

  it('a relight goes to the host in order; with no publish it releases the clock only for a tick, not for a regeneration', () => {
    const { link, log, answer } = fake()
    link.submit(1, null, [0, 0, 32], true, 0)
    answer(0, false)
    link.submit(-1, null, [0, 0, 32], false, 0)
    answer(1, false)
    expect(log).toEqual(['post 1 @0.6', 'copy 1 (no publish)', 'settled', 'post -1 @0.6', 'copy -1 (no publish)'])
  })

  it('a deferred publish keeps the hold (no applied) and the queue moves on', () => {
    const { link, log, answer } = fake()
    link.submit(1, tickOf(1), [], true, 0)
    link.submit(2, tickOf(2), [], true, 0)
    answer(0, false)
    answer(1)
    expect(log).toEqual(['post 1 @0.6', 'copy 1', 'post 2 @0.6', 'copy 2', 'applied 2 from 0'])
  })

  it('after reset, a late reply is ignored and the next tick goes out at once', () => {
    const { link, posted, log } = fake()
    link.submit(1, tickOf(1), [], true, 0)
    link.reset()
    link.receive(reply(posted[0]!, true))
    expect(log).toEqual(['post 1 @0.6'])
    link.submit(2, tickOf(2), [], true, 0)
    expect(posted.map(p => p.tick)).toEqual([1, 2])
  })

  it('a queue deep enough that the sim reuses a parity buffer recovers like today: the stale publish defers, the next reads it (forced, real publisher)', () => {
    const w = gateWorld()
    w.edges.ensure(w.cols, w.under, 32)
    const SIZE: [number, number, number] = [64, 32, 32]
    const pub = new WaterPublisher(w.buffers.water)
    const ref = new SurfaceView(SIZE, w.buffers.water, () => 15, 20)
    const mirror = new SurfaceMirror(SIZE, w.buffers.water)
    const host = new WaterHost(SIZE, w.buffers.water, () => 15, 20, mirror.surfaces)
    const posted: WaterRequest[] = [], applied: number[] = [], replies: boolean[] = []
    const link = new WaterLink({ post: (r) => posted.push(r), copy: (r) => { replies.push(r.applied); mirror.copy(r) }, applied: (t) => applied.push(t), settled: () => {}, shown: () => 1 })
    const all = Array.from({ length: w.cols.tiles.count }, (_, t) => t)
    const step = (tick: number) => {
      const water = pub.publish(all, w.cols, { under: w.under, edges: w.edges, height: 32 })!
      ref.apply(water, 1) // the reference reads every publish at once, before its buffer is reused
      link.submit(tick, water, [], true, 0)
      w.step()
    }
    // Three publishes before any reply: the third writes the first's parity buffer.
    step(1); step(2); step(3)
    let delivered = 0
    const deliver = () => { while (delivered < posted.length) link.receive(host.handle(posted[delivered++]!)) }
    deliver()
    expect(replies.slice(0, 3)).toEqual([false, true, true]) // the reuse really happened
    expect(applied.slice(0, 2)).toEqual([2, 3])
    // Run on, replying at once, while the water still runs (it drains through the gate for thousands of ticks): once the
    // recovery has re-read the stale tiles, what is drawn is what the prompt reference draws.
    for (let tick = 4; tick < 14; tick++) { step(tick); deliver() }
    expect(w.cols.tiles.awakeCount()).toBeGreaterThan(0)
    for (let r = 0; r < 4; r++) for (let cc = 0; cc < ref.ccCount; cc++) {
      const a = ref.column(cc, r), m = mirror.column(cc, r)
      expect([r, cc, !!a]).toEqual([r, cc, !!m])
      if (!a || !m) continue
      const same = (x: Float32Array, y: Float32Array) => x.every((v, i) => Object.is(v, y[i]))
      expect([r, cc, same(m.hPrev, a.hPrev), same(m.hCur, a.hCur), same(m.info, a.info), m.curtains.count === a.curtains.count]).toEqual([r, cc, true, true, true, true])
    }
  }, 120_000)
})
