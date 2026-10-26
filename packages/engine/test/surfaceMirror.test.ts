import { describe, expect, it } from 'vitest'
import { SURFACE_ATTRIBUTES, SurfaceView } from '../src/render/water/surfaceView.ts'
import { WaterHost } from '../src/render/water/waterHost.ts'
import { SurfaceMirror } from '../src/render/water/surfaceMirror.ts'
import { RANKS } from '../src/sim/water/constants.ts'
import { WaterPublisher } from '../src/sim/water/publish.ts'
import { gateWorld } from './layerHelpers.ts'

/** The first index where two arrays differ (Object.is), −1 when equal. */
const diff = (x: ArrayLike<number>, y: ArrayLike<number>): number => {
  if (x.length !== y.length) return -2
  for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return i
  return -1
}
const SIZE: [number, number, number] = [64, 32, 32]

describe('SurfaceMirror (4a-r2 #2)', () => {
  it('holds exactly what an in-thread view holds after every request, with alpha, relights and queued publishes (differential)', () => {
    const w = gateWorld()
    w.edges.ensure(w.cols, w.under, 32)
    let shift = 0
    const light = (x: number, y: number, z: number) => (x * 7 + y * 3 + z + shift) & 0xff
    const pub = new WaterPublisher(w.buffers.water)
    const ref = new SurfaceView(SIZE, w.buffers.water, light, 20)
    const mirror = new SurfaceMirror(SIZE, w.buffers.water)
    const host = new WaterHost(SIZE, w.buffers.water, light, 20, mirror.surfaces)
    const all = Array.from({ length: w.cols.tiles.count }, (_, t) => t)
    let id = 0, compared = 0
    for (let tick = 0; tick < 48; tick++) {
      // Every 5th tick two publishes come before a reply: WaterLink forwards the second after the first's copy, at alpha 0.
      for (let q = 0; q < (tick % 5 === 0 ? 2 : 1); q++) {
        const water = pub.publish(all, w.cols, { under: w.under, edges: w.edges, height: 32 })!
        const shown = q === 0 ? (tick % 3) / 3 : 0
        if (tick % 4 === 0) shift++
        const relight = tick % 4 === 0 ? [0, 0, 32, 1, 0, 16] : []
        ref.apply(water, shown)
        for (let i = 0; i < relight.length; i += 3) ref.relight(relight[i]!, relight[i + 1]!, relight[i + 2]!)
        mirror.copy(host.handle({ type: 'apply', id: ++id, shown, entries: [{ tick, water, relight }] }))
        for (let r = 0; r < RANKS; r++) for (let cc = 0; cc < ref.ccCount; cc++) {
          const a = ref.column(cc, r), m = mirror.column(cc, r)
          expect([tick, r, cc, !!a]).toEqual([tick, r, cc, !!m])
          if (!a || !m) continue
          for (const name of SURFACE_ATTRIBUTES) expect(diff(m[name], a[name]), `${name}, tick ${tick}, layer ${r}, chunk ${cc}`).toBe(-1)
          const n = a.curtains.count * 4
          expect([tick, r, cc, diff(m.hPrev, a.hPrev), diff(m.hCur, a.hCur), diff(m.info, a.info), m.curtains.count - a.curtains.count,
            diff(m.curtains.prev.subarray(0, n), a.curtains.prev.subarray(0, n)), diff(m.curtains.cur.subarray(0, n), a.curtains.cur.subarray(0, n)),
            diff(m.curtains.reach.subarray(0, n), a.curtains.reach.subarray(0, n)), diff(m.curtains.thick.subarray(0, n), a.curtains.thick.subarray(0, n)),
            diff(m.curtains.flare.subarray(0, n), a.curtains.flare.subarray(0, n)), diff(m.curtains.info.subarray(0, n), a.curtains.info.subarray(0, n)),
          ]).toEqual([tick, r, cc, -1, -1, -1, 0, -1, -1, -1, -1, -1, -1])
          compared++
        }
        for (let z = 0; z < SIZE[2]; z++) for (let x = 0; x < SIZE[0]; x++) {
          expect([x, z, mirror.surfaceAt(x, z)]).toEqual([x, z, ref.surfaceAt(x, z)])
          for (const y of [2, 4, 7, 10]) expect([x, z, y, mirror.surfaceNear(x, z, y)]).toEqual([x, z, y, ref.surfaceNear(x, z, y)])
        }
        w.step()
      }
    }
    expect(compared).toBeGreaterThan(100)
    // The world must reach the layered path: some layer-1 column data exists.
    expect(Array.from({ length: ref.ccCount }, (_, cc) => ref.column(cc, 1)).some(Boolean)).toBe(true)
  }, 120_000)

  it('sample(): the drawn top water of a column (surface, depth, flow, white, falls), null where none is drawn', () => {
    const w = gateWorld()
    w.edges.ensure(w.cols, w.under, 32)
    const light = () => 0xff
    const pub = new WaterPublisher(w.buffers.water)
    const mirror = new SurfaceMirror(SIZE, w.buffers.water)
    const host = new WaterHost(SIZE, w.buffers.water, light, 20, mirror.surfaces)
    const all = Array.from({ length: w.cols.tiles.count }, (_, t) => t)
    let wet = 0, moving = 0, falls = 0
    for (let tick = 0; tick < 24; tick++) {
      const water = pub.publish(all, w.cols, { under: w.under, edges: w.edges, height: 32 })!
      mirror.copy(host.handle({ type: 'apply', id: tick + 1, shown: 0, entries: [{ tick, water, relight: [] }] }))
      w.step()
    }
    for (let z = 0; z < SIZE[2]; z++) for (let x = 0; x < SIZE[0]; x++) {
      const s = mirror.sample(x, z), at = mirror.surfaceAt(x, z)
      if (!s) { expect([x, z, at === null || mirror.column((x >> 5) + (z >> 5) * mirror.cx)?.info[((x & 31) + (z & 31) * 32) * 4 + 3]! < 0]).toEqual([x, z, true]); continue }
      expect([x, z, s.surface]).toEqual([x, z, at])
      expect(s.depth).toBeGreaterThan(0); expect(s.white).toBeGreaterThanOrEqual(0); expect(s.white).toBeLessThanOrEqual(15)
      expect([0, 1, 2.5].some(f => Math.abs(s.flow - f) < 1e-6)).toBe(true)
      wet++; if (s.flow > 0) moving++; falls += s.falls
    }
    expect(wet).toBeGreaterThan(0)
    expect(moving + falls).toBeGreaterThan(0)
    expect([mirror.sample(-1, 0), mirror.sample(0, SIZE[2])]).toEqual([null, null])
  }, 60_000)
})
