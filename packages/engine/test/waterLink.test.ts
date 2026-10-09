import { describe, expect, it } from 'vitest'
import { SurfaceView } from '../src/render/water/surfaceView.ts'
import { WaterHost, type WaterReply, type WaterRequest } from '../src/render/water/waterHost.ts'
import { WaterLink } from '../src/render/water/waterLink.ts'
import { SurfaceMirror } from '../src/render/water/surfaceMirror.ts'
import { WaterPublisher, type WaterTick } from '../src/sim/water/publish.ts'
import { AIR, STONE, gateWorld, layered, wv } from './layerHelpers.ts'

const tickOf = (seq: number): WaterTick => ({ seq, parity: seq & 1, tiles: [], layers: null })
const ticks = (req: WaterRequest) => req.entries.map(e => e.tick).join(',')
/** A reply to `req`: `applied` for every entry, or per entry. */
const reply = (req: WaterRequest, applied: boolean | boolean[]): WaterReply =>
  ({ type: 'result', id: req.id, applied: Array.isArray(applied) ? applied : req.entries.map(() => applied), hostMs: 0, keys: new Int32Array(), data: new Float32Array() })

/** A link over a fake host: requests wait until `answer` replies to them; `log` records the hooks in order. */
function fake(onScreen = { v: 0.6 }) {
  const posted: WaterRequest[] = [], log: string[] = []
  const link = new WaterLink({
    post: (req) => { posted.push(req); log.push(`post ${ticks(req)} @${req.shown}`) },
    copy: (r, publish) => log.push(`copy ${ticks(posted.find(p => p.id === r.id)!)}${publish ? '' : ' (no publish)'}`),
    applied: (tick, arrived) => { onScreen.v = 0; log.push(`applied ${tick} from ${arrived}`) },
    settled: () => log.push('settled'),
    shown: () => onScreen.v,
  })
  return { link, posted, log, answer: (i: number, applied: boolean | boolean[] = true) => link.receive(reply(posted[i]!, applied)) }
}

/** Whether two views' columns hold the same draw data, bit for bit, everywhere. */
function sameColumns(a: { ccCount: number; column(cc: number, r: number): unknown }, m: { column(cc: number, r: number): unknown }): string[] {
  type Col = { hPrev: Float32Array; hCur: Float32Array; info: Float32Array; curtains: { count: number } }
  const bad: string[] = [], same = (x: Float32Array, y: Float32Array) => x.every((v, i) => Object.is(v, y[i]))
  for (let r = 0; r < 4; r++) for (let cc = 0; cc < a.ccCount; cc++) {
    const p = a.column(cc, r) as Col | undefined, q = m.column(cc, r) as Col | undefined
    if (!!p !== !!q) { bad.push(`${r}/${cc} presence`); continue }
    if (!p || !q) continue
    if (!same(p.hPrev, q.hPrev) || !same(p.hCur, q.hCur) || !same(p.info, q.info) || p.curtains.count !== q.curtains.count) bad.push(`${r}/${cc}`)
  }
  return bad
}

/**
 * Two lakes that drain, far apart: lake A in rows z 1–9 of chunk column 0, lake B in rows z 20–28 of chunk column 1. 64 × 32 × 32.
 * `tilesA` / `tilesB` are the 16 × 16 tiles each one moves in.
 */
function twoLakes() {
  const w = layered((x, y, z) => {
    if (y < 2 || x === 0 || x === 63 || z === 0 || z === 31) return STONE
    if (x >= 1 && x <= 6 && z >= 1 && z <= 9) return y <= 10 ? wv(7) : AIR
    if (x >= 40 && x <= 45 && z >= 20 && z <= 28) return y <= 10 ? wv(7) : AIR
    return AIR
  }, [64, 32, 32])
  w.edges.ensure(w.cols, w.under, 32)
  return { w, tilesA: [0, 1], tilesB: [6, 7] }
}

describe('WaterLink (4a-r2 #2, spec 4.1)', () => {
  it('two publishes before the first reply: one in flight, the second sent after the first copy, at alpha 0, in order', () => {
    const { link, posted, log, answer } = fake()
    link.submit(1, tickOf(1), [], true, 100)
    link.submit(2, tickOf(2), [], true, 120)
    expect(posted.map(ticks)).toEqual(['1'])
    expect([link.depth, link.frozen]).toEqual([2, 0.6])
    answer(0)
    expect(posted.map(ticks)).toEqual(['1', '2'])
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
    expect(posted.map(ticks)).toEqual(['1', '2'])
  })

  it('a queue deep enough that the sim reuses a parity buffer: the stale publish catches up from the newest buffer, and the view ends as the prompt one (forced, real publisher)', () => {
    const w = gateWorld()
    w.edges.ensure(w.cols, w.under, 32)
    const SIZE: [number, number, number] = [64, 32, 32]
    const pub = new WaterPublisher(w.buffers.water)
    const ref = new SurfaceView(SIZE, w.buffers.water, () => 15, 20)
    const mirror = new SurfaceMirror(SIZE, w.buffers.water)
    const host = new WaterHost(SIZE, w.buffers.water, () => 15, 20, mirror.surfaces, true)
    const posted: WaterRequest[] = [], applied: number[] = [], replies: boolean[] = []
    const link = new WaterLink({ post: (r) => posted.push(r), copy: (r) => { replies.push(...r.applied); mirror.copy(r) }, applied: (t) => applied.push(t), settled: () => {}, shown: () => 1 })
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
    link.receive(host.handle(posted[delivered++]!))
    // Tick 1's buffer was reused (the reuse really happened): it caught up from publish 3's, so its tops are 3's.
    expect([replies[0], host.view.catchUps]).toEqual([true, 1])
    expect(host.view.cur.every((v, c) => v === ref.cur[c])).toBe(true)
    deliver()
    // In the batch 2,3: 2 is stale and not last, so it defers cheaply; 3 reads it along (no second catch-up).
    expect([applied.slice(0, 2), host.view.catchUps]).toEqual([[1, 3], 1])
    // Run on, replying at once, while the water still runs (it drains through the gate for thousands of ticks): once the
    // later ticks have come in, what is drawn (tops and lower layers) is what the prompt reference draws, and the mirror
    // holds what the host's own view holds.
    for (let tick = 4; tick < 14; tick++) { step(tick); deliver() }
    expect(w.cols.tiles.awakeCount()).toBeGreaterThan(0)
    expect(sameColumns(host.view, mirror)).toEqual([])
    for (let r = 0; r < 4; r++) for (let cc = 0; cc < ref.ccCount; cc++) {
      const a = ref.column(cc, r), m = mirror.column(cc, r)
      expect([r, cc, !!a]).toEqual([r, cc, !!m])
      if (!a || !m) continue
      const same = (x: Float32Array, y: Float32Array) => x.every((v, i) => Object.is(v, y[i]))
      expect([r, cc, same(m.hPrev, a.hPrev), same(m.hCur, a.hCur), same(m.info, a.info), m.curtains.count === a.curtains.count]).toEqual([r, cc, true, true, true, true])
    }
  }, 120_000)

  it('the in-thread host never catches up: a stale tick defers as before, and the next reads it', () => {
    const w = gateWorld()
    w.edges.ensure(w.cols, w.under, 32)
    const SIZE: [number, number, number] = [64, 32, 32]
    const pub = new WaterPublisher(w.buffers.water), mirror = new SurfaceMirror(SIZE, w.buffers.water)
    const host = new WaterHost(SIZE, w.buffers.water, () => 15, 20, mirror.surfaces) // in-thread: no catch-up
    const all = Array.from({ length: w.cols.tiles.count }, (_, t) => t), layers = { under: w.under, edges: w.edges, height: 32 }
    const p1 = pub.publish(all, w.cols, layers)!; w.step()
    pub.publish(all, w.cols, layers); w.step()
    const p3 = pub.publish(all, w.cols, layers)! // reuses p1's buffer
    const r1 = host.handle({ type: 'apply', id: 1, shown: 1, entries: [{ tick: 1, water: p1, relight: [] }] })
    const r3 = host.handle({ type: 'apply', id: 2, shown: 1, entries: [{ tick: 3, water: p3, relight: [] }] })
    expect([r1.applied, r3.applied, host.view.catchUps]).toEqual([[false], [true], 0])
  })

  it('everything queued behind the request in flight goes out as one batch after its copy, in tick order (spec 4.1, batched)', () => {
    const { link, posted, log, answer } = fake()
    link.submit(1, tickOf(1), [], true, 100)
    link.submit(2, tickOf(2), [], true, 110)
    link.submit(3, tickOf(3), [], true, 120)
    link.submit(4, tickOf(4), [], true, 130)
    expect(posted.map(ticks)).toEqual(['1'])
    expect(link.depth).toBe(4)
    answer(0)
    expect(posted.map(ticks)).toEqual(['1', '2,3,4'])
    expect([link.depth, link.frozen]).toEqual([3, 0])
    answer(1, [true, false, true]) // 3 deferred: no applied for it, and the queue moves on
    expect([link.depth, link.frozen]).toEqual([0, null])
    expect(log).toEqual(['post 1 @0.6', 'copy 1', 'applied 1 from 100', 'post 2,3,4 @0', 'copy 2,3,4', 'applied 2 from 110', 'applied 4 from 130'])
  })

  it('ticks without anything for the host settle in order inside a batch, and lead ones settle at once', () => {
    const { link, posted, log, answer } = fake()
    link.submit(1, tickOf(1), [], true, 0)
    link.submit(2, null, [], true, 0)
    link.submit(3, tickOf(3), [], true, 0)
    link.submit(4, null, [], true, 0)
    link.submit(5, null, [0, 0, 32], false, 0) // a regeneration's relight: no settle
    answer(0)
    expect(posted.map(ticks)).toEqual(['1', '3,4,5'])
    answer(1, [true, false, false])
    expect(log).toEqual(['post 1 @0.6', 'copy 1', 'applied 1 from 0', 'settled', 'post 3,4,5 @0', 'copy 3,4,5', 'applied 3 from 0', 'settled'])
  })

  it('a batched reply copies the union of the rows its entries changed: the mirror equals the in-thread view applying them one by one', () => {
    const { w, tilesA, tilesB } = twoLakes()
    const SIZE: [number, number, number] = [64, 32, 32]
    const pub = new WaterPublisher(w.buffers.water)
    const ref = new SurfaceView(SIZE, w.buffers.water, () => 15, 20)
    const mirror = new SurfaceMirror(SIZE, w.buffers.water)
    const host = new WaterHost(SIZE, w.buffers.water, () => 15, 20, mirror.surfaces, true)
    const all = Array.from({ length: w.cols.tiles.count }, (_, t) => t)
    const layers = { under: w.under, edges: w.edges, height: 32 }
    // The first publish lists every tile, applied alone by both.
    const p0 = pub.publish(all, w.cols, layers)!
    ref.apply(p0, 1)
    mirror.copy(host.handle({ type: 'apply', id: 1, shown: 1, entries: [{ tick: 0, water: p0, relight: [] }] }))
    for (let round = 0; round < 6; round++) {
      // Lake A's tiles, then lake B's: the second entry changes rows (z 20–28, chunk column 1) the first did not. (The
      // publisher lists the previous publish's tiles again, so a later entry always re-lists an earlier one's.)
      w.step(); const pA = pub.publish([...tilesA], w.cols, layers)!
      w.step(); const pB = pub.publish([...tilesB], w.cols, layers)!
      const shown = 0.25 + round / 10
      expect([ref.apply(pA, shown), ref.apply(pB, 0)]).toEqual([true, true])
      const r = host.handle({ type: 'apply', id: 2 + round, shown, entries: [{ tick: 2 * round + 1, water: pA, relight: [] }, { tick: 2 * round + 2, water: pB, relight: [] }] })
      expect(r.applied).toEqual([true, true])
      // The reply carries keys from both chunk columns.
      const ccs = new Set<number>()
      for (let k = 0; k < r.keys.length; k += 4) ccs.add(r.keys[k]! % host.view.ccCount)
      if (round === 0) expect([...ccs].sort()).toEqual([0, 1])
      mirror.copy(r)
      expect(sameColumns(ref, mirror)).toEqual([])
    }
  }, 120_000)

  it('a worker lost with a batch in flight: the late reply is ignored, nothing is applied twice, and the resync draws what a fresh view draws', () => {
    const { w } = twoLakes()
    const SIZE: [number, number, number] = [64, 32, 32]
    const pub = new WaterPublisher(w.buffers.water)
    const mirror = new SurfaceMirror(SIZE, w.buffers.water)
    let host = new WaterHost(SIZE, w.buffers.water, () => 15, 20, mirror.surfaces, true)
    const all = Array.from({ length: w.cols.tiles.count }, (_, t) => t)
    const layers = { under: w.under, edges: w.edges, height: 32 }
    const posted: WaterRequest[] = [], applied: number[] = []
    const link = new WaterLink({ post: (r) => posted.push(r), copy: (r) => mirror.copy(r), applied: (t) => applied.push(t), settled: () => {}, shown: () => 0.5 })
    const publish = (tick: number) => { w.step(); link.submit(tick, pub.publish(all, w.cols, layers), [], true, 0) }
    publish(1)
    link.receive(host.handle(posted[0]!))
    publish(2); publish(3); publish(4) // 2 in flight, 3 and 4 queued (4 reuses 2's parity buffer: 2 catches up)
    link.receive(host.handle(posted[1]!))
    expect(posted.map(ticks)).toEqual(['1', '2', '3,4'])
    const lateReply = host.handle(posted[2]!)
    // The worker is lost with the batch 3,4 in flight (engine: reset, the mirror reset, a new host, then waterResync).
    link.reset(); mirror.reset()
    host = new WaterHost(SIZE, w.buffers.water, () => 15, 20, mirror.surfaces, true)
    link.receive(lateReply)
    expect(applied).toEqual([1, 2])
    // The resync: the next publish lists every tile.
    w.step()
    const resync = pub.publish(all, w.cols, layers)!
    link.submit(5, resync, [], true, 0)
    expect(posted.map(ticks)).toEqual(['1', '2', '3,4', '5'])
    link.receive(host.handle(posted[3]!))
    expect(applied).toEqual([1, 2, 5])
    const fresh = new SurfaceView(SIZE, w.buffers.water, () => 15, 20)
    fresh.apply(resync, 0.5)
    expect(sameColumns(fresh, mirror)).toEqual([])
    // And the link goes on.
    publish(6)
    expect(posted.map(ticks)).toEqual(['1', '2', '3,4', '5', '6'])
  }, 120_000)
})
