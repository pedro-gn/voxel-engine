import { describe, expect, it } from 'vitest'
import { RippleSet, editRipples } from '../src/render/water/ripples.ts'
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
  }, 30_000) // ~1.5 s alone; give it room beside the parallel suite

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

describe('curtains and ripples in layers', () => {
  it('water falling inside a cave hangs a straight curtain: no reach, no flare, foot at the water below', () => {
    // a cave (y 2–6) under a roof at y 7; a ledge (x 8–15 floor 4) above a lower pool (x 16–30 floor 2), both in the cave
    const w = layered((x, y, z) => {
      if (y < 2 || y >= 7 || x === 0 || x === 31 || z === 0 || z >= 4) return STONE
      if (x <= 15 && y < 4) return STONE
      if (x <= 15) return y === 4 ? wv(7) : AIR
      return y === 2 ? wv(4) : AIR
    })
    w.edges.ensure(w.cols, w.under, 32)
    for (let k = 0; k < 4; k++) w.step() // the ledge starts pouring
    const pub = new WaterPublisher(w.buffers.water), view = new SurfaceView([32, 32, 32], w.buffers.water, () => 15)
    const all = Array.from({ length: w.cols.tiles.count }, (_, t) => t)
    view.apply(pub.publish(all, w.cols, { under: w.under, edges: w.edges, height: 32 })!)
    const d = view.column(0, 1)!, cs = d.curtains
    expect(cs.count).toBeGreaterThan(0)
    for (let k = 0; k < cs.count; k++) {
      expect(cs.reach[k * 4 + 2]).toBe(0)
      expect(cs.reach[k * 4 + 3]).toBe(0)
      expect(cs.thick[k * 4 + 2]).toBe(0)
      expect(cs.cur[k * 4 + 2]!).toBeLessThan(cs.cur[k * 4]!) // the foot is below the top
    }
  })

  it('water leaving a lower layer into the open (a dam hole) is thrown out in an arc, not stuck to the wall', () => {
    // a lake (z 1–9, water y 6–13) behind a dam (z 10, solid to y 20) with a hole at y 6–7, x 12–15; a valley (floor 2) beyond it
    const w = layered((x, y, z) => {
      if (y < 2 || x === 0 || x === 31 || z === 0 || z === 31) return STONE
      if (z <= 9) return y < 6 ? STONE : y <= 13 ? wv(7) : y <= 20 ? AIR : AIR
      if (z === 10) return x >= 12 && x <= 15 && (y === 6 || y === 7) ? AIR : y <= 20 ? STONE : AIR
      return AIR
    })
    w.edges.ensure(w.cols, w.under, 32)
    for (let k = 0; k < 6; k++) w.step() // the hole pours
    const pub = new WaterPublisher(w.buffers.water), view = new SurfaceView([32, 32, 32], w.buffers.water, () => 15)
    view.apply(pub.publish(Array.from({ length: w.cols.tiles.count }, (_, t) => t), w.cols, { under: w.under, edges: w.edges, height: 32 })!)
    const cs = view.column(0, 1)!.curtains
    let thrown = 0
    for (let k = 0; k < cs.count; k++) if (cs.info[k * 4 + 2]! % 4 === 2 && cs.reach[k * 4 + 2]! > 0) thrown++
    expect(thrown).toBe(4) // the hole's four columns, each thrown out (+z) away from the dam
  })

  it('a slot full to its ceiling takes its light from inside its run, never from the block above it (its curtain is not black)', () => {
    // a hole one block high (y 9, x 12–15) through a dam (z 10) mid-way down a lake (y 2–13): its surface is always in its
    // only cell, so ceil() of it is the roof (y 10)
    const w = layered((x, y, z) => {
      if (y < 2 || x === 0 || x === 31 || z === 0 || z === 31) return STONE
      if (z <= 9) return y <= 13 ? wv(7) : AIR
      if (z === 10) return x >= 12 && x <= 15 && y === 9 ? AIR : y <= 20 ? STONE : AIR
      return AIR
    })
    w.edges.ensure(w.cols, w.under, 32)
    for (let k = 0; k < 6; k++) w.step()
    const lightOf = (x: number, y: number, z: number) => ((w.store.getVoxel(x, y, z) & 0xfff) === STONE ? 0 : 15) // sky 15 in the open, 0 in rock
    const pub = new WaterPublisher(w.buffers.water), view = new SurfaceView([32, 32, 32], w.buffers.water, lightOf)
    view.apply(pub.publish(Array.from({ length: w.cols.tiles.count }, (_, t) => t), w.cols, { under: w.under, edges: w.edges, height: 32 })!)
    expect(w.segs(13, 10)[0]!.depth).toBeGreaterThan(0)
    const d = view.column(0, 1)!, packed = d.info[(13 + 10 * 32) * 4 + 3]!
    expect(packed % 256 >> 4).toBe(15) // sky light of the hole, not the roof's 0
    const cs = d.curtains
    for (let k = 0; k < cs.count; k++) expect((Math.floor(cs.info[k * 4 + 2]! / 4) % 256) >> 4).toBe(15)
  })

  it('surfaceNear finds the slot at the edit height: the lake under a bridge, not the dry deck above', () => {
    const { view, publish } = bridgedView()
    publish()
    expect(view.surfaceNear(15, 2, 5)).toBeCloseTo(6, 6)
    expect(view.surfaceNear(15, 2, 20)).toBeNull()
  })

  it('a block dropped at the lake level under a wide deck rings on the lake, though every column around it is dry on top', () => {
    const w = layered((x, y, z) => {
      if (y < 2 || x === 0 || x === 31 || z === 0 || z >= 6) return STONE
      if (x >= 12 && x <= 18 && y === 7) return STONE // a deck 7 blocks wide over the whole channel
      return y <= 5 ? wv(7) : AIR
    })
    w.edges.ensure(w.cols, w.under, 32)
    const pub = new WaterPublisher(w.buffers.water), view = new SurfaceView([32, 32, 32], w.buffers.water, () => 15)
    view.apply(pub.publish(Array.from({ length: w.cols.tiles.count }, (_, t) => t), w.cols, { under: w.under, edges: w.edges, height: 32 })!)
    const set = new RippleSet()
    editRipples(view, set, { type: 'setBlock', pos: [15, 5, 3], voxel: STONE }, () => AIR)
    expect(set.count).toBe(1)
    expect(set.y[0]).toBeCloseTo(6, 6) // the lake under the deck: 2 + 4 blocks
  })
})

describe('what a body looks like from the free side (final review I1, I2)', () => {
  /** Task 6's U-tube, full and settled: a lake (x 1–20), a full tunnel (x 21–40, y 12–13, z 5–6) under the hill, a shaft (x 41–42). */
  function uTubeView() {
    const w = layered((x, y, z) => {
      if (y < 10) return STONE
      if (x >= 1 && x <= 20 && z >= 1 && z <= 10) return y <= 19 ? wv(7) : AIR
      if (z >= 5 && z <= 6 && y >= 12 && y <= 13 && x >= 21 && x <= 40) return wv(7)
      if (z >= 5 && z <= 6 && x >= 41 && x <= 42 && y >= 12) return y <= 19 ? wv(7) : AIR
      return y <= 24 ? STONE : AIR
    }, [64, 32, 32])
    w.settle(60_000)
    w.edges.ensure(w.cols, w.under, 32)
    const pub = new WaterPublisher(w.buffers.water), view = new SurfaceView([64, 32, 32], w.buffers.water, () => 15)
    view.apply(pub.publish(Array.from({ length: w.cols.tiles.count }, (_, t) => t), w.cols, { under: w.under, edges: w.edges, height: 32 })!)
    return { w, view }
  }
  const mask = (view: SurfaceView, x: number, z: number, r: number) => {
    const d = view.column((x >> 5) + (z >> 5) * view.cx, r)
    return d ? d.curtainMask[(x & 31) + (z & 31) * 32]! : 0
  }

  it('hangs no curtain on the rock face above a full tunnel mouth: the lake and the shaft meet a wall there', () => {
    const { view } = uTubeView()
    expect(mask(view, 20, 5, 0)).toBe(0)
    expect(mask(view, 41, 5, 0)).toBe(0)
  })

  it('draws no quad for a full tunnel: its water has no free surface', () => {
    const { w, view } = uTubeView()
    expect(w.under.body[w.under.first[25 + 5 * 64]!]).toBeGreaterThanOrEqual(0)
    const d = view.column(0, 1)
    expect(d ? d.info[((25 & 31) + 5 * 32) * 4 + 3]! : -1).toBeLessThan(0)
  })
})
