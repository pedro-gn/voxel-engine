import { describe, expect, it } from 'vitest'
import { SurfaceView } from '../src/render/water/surfaceView.ts'
import { WaterColumns } from '../src/sim/water/columns.ts'
import { SUB } from '../src/sim/water/constants.ts'
import { WaterPublisher } from '../src/sim/water/publish.ts'
import { createWaterBuffers } from '../src/world/waterBuffers.ts'
import { AIR, STONE, layered, wv } from './layerHelpers.ts'

function corners(view: SurfaceView, x: number, z: number, r: number, f: 'hCur' | 'hPrev' | 'info' = 'hCur'): number[] {
  const d = view.column((x >> 5) + (z >> 5) * view.cx, r)!
  const o = ((x & 31) + (z & 31) * 32) * 4
  return [...d[f].subarray(o, o + 4)]
}

/** The first index where two arrays differ (Object.is, as toEqual), −1 when equal; toEqual on whole typed arrays is too slow here. */
const diff = (x: ArrayLike<number>, y: ArrayLike<number>): number => {
  if (x.length !== y.length) return -2
  for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return i
  return -1
}

describe('the layered refresh path', () => {
  it('draws exactly what the fast path draws on a world with no layers (differential, random changes)', () => {
    const S = 64, b = createWaterBuffers([S, 32, S])
    const cols = new WaterColumns(S, S, new Int16Array(b.floor))
    let seed = 11
    const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
    for (let c = 0; c < S * S; c++) { cols.floor[c] = 2 + Math.floor(rand() * 3); cols.depth[c] = rand() < 0.6 ? Math.floor(rand() * 3 * SUB) : 0 }
    const pub = new WaterPublisher(b)
    const fast = new SurfaceView([S, 32, S], b, () => 15), slow = new SurfaceView([S, 32, S], b, () => 15)
    slow.forceLayered = true
    const T = S / 16
    for (let tick = 0; tick < 30; tick++) {
      const changed = new Set<number>()
      for (let m = 0; m < 3; m++) {
        const t = Math.floor(rand() * T * T), x0 = (t % T) * 16, z0 = Math.floor(t / T) * 16
        changed.add(t)
        for (let z = z0; z < z0 + 16; z++) for (let x = x0; x < x0 + 16; x++) {
          const c = x + z * S
          cols.depth[c] = Math.max(0, cols.depth[c]! + Math.floor((rand() - 0.5) * 200))
          cols.flux[2 * c] = Math.floor((rand() - 0.5) * 800); cols.flux[2 * c + 1] = Math.floor((rand() - 0.5) * 800)
        }
      }
      const tick0 = pub.publish([...changed].sort((a, b2) => a - b2), cols)!
      fast.apply(tick0); slow.apply(tick0)
      for (let cc = 0; cc < fast.cx * fast.cz; cc++) {
        const a = fast.column(cc), s = slow.column(cc)
        expect(!!a).toBe(!!s)
        if (!a || !s) continue
        expect([tick, cc, diff(s.hCur, a.hCur), diff(s.hPrev, a.hPrev), diff(s.info, a.info), diff(s.curtainMask, a.curtainMask),
          diff(s.curtains.cur.subarray(0, s.curtains.count * 4), a.curtains.cur.subarray(0, a.curtains.count * 4))]).toEqual([tick, cc, -1, -1, -1, -1, -1])
      }
    }
  })

  /** The bridged channel of Task 9's tests, published with its layers into a view. */
  function bridgedView() {
    const w = layered((x, y, z) => {
      if (y < 2 || x === 0 || x === 31 || z === 0 || z >= 4) return STONE
      if (x === 15 && y === 7) return STONE
      return y <= 5 ? wv(7) : AIR
    })
    w.edges.ensure(w.cols, w.under, 32)
    const pub = new WaterPublisher(w.buffers.water), view = new SurfaceView([32, 32, 32], w.buffers.water, () => 15)
    const all = Array.from({ length: w.cols.tiles.count }, (_, t) => t)
    const publish = () => view.apply(pub.publish(all, w.cols, { under: w.under, edges: w.edges, height: 32 })!)
    return { w, view, publish }
  }

  it('the water under a bridge is drawn in layer 1 and meets the lake in layer 0 with no seam', () => {
    const { view, publish } = bridgedView()
    publish()
    const under = corners(view, 15, 2, 1), west = corners(view, 14, 2, 0), east = corners(view, 16, 2, 0)
    expect(under[0]).toBeCloseTo(west[1]!, 6) // (−x,−z) of the slot = (+x,−z) of the lake column west of it
    expect(under[3]).toBeCloseTo(west[2]!, 6)
    expect(under[1]).toBeCloseTo(east[0]!, 6)
    expect(under[2]).toBeCloseTo(east[3]!, 6)
    expect(under[0]).toBeCloseTo(6, 6) // the lake's surface: 2 + 4 blocks
    expect(corners(view, 15, 2, 0, 'info')[3]).toBeLessThan(0) // the deck's top segment is dry: nothing drawn in layer 0
  })

  it('a slot drained between publishes sinks, then leaves no quad behind (Review Focus 5)', () => {
    const { w, view, publish } = bridgedView()
    publish()
    expect(corners(view, 15, 2, 1, 'info')[3]).toBeGreaterThanOrEqual(0)
    for (let z = 1; z <= 3; z++) w.under.depth[w.under.first[15 + z * 32]!] = 0
    publish()
    publish()
    publish()
    expect(corners(view, 15, 2, 1, 'info')[3]).toBeLessThan(0)
  })
})
