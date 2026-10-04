import { describe, expect, it, vi } from 'vitest'
import { SINK, quantizeFlow } from '../src/render/water/surfaceMesh.ts'
import { SurfaceView } from '../src/render/water/surfaceView.ts'
import { WaterColumns } from '../src/sim/water/columns.ts'
import { SUB } from '../src/sim/water/constants.ts'
import { WaterPublisher } from '../src/sim/water/publish.ts'
import { createWaterBuffers } from '../src/world/waterBuffers.ts'

/** Packed voxel light for every column: sky 15, block 0. */
const SKY15 = 15
const LIT = 15 * 16 // info.w for that light and no white water

/** A heightfield, its publisher and a view. `publish(tiles?)` publishes (every tile by default) and applies the tick. */
function scene(sx: number, sz: number, floor: (x: number, z: number) => number, depth: (x: number, z: number) => number) {
  const b = createWaterBuffers([sx, 32, sz])
  const cols = new WaterColumns(sx, sz, new Int16Array(b.floor))
  const set = (f: (x: number, z: number) => number, d: (x: number, z: number) => number) => {
    for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) { cols.floor[x + z * sx] = f(x, z); cols.depth[x + z * sx] = d(x, z) }
  }
  set(floor, depth)
  const pub = new WaterPublisher(b)
  const view = new SurfaceView([sx, 32, sz], b, () => SKY15)
  const all = Array.from({ length: cols.tiles.count }, (_, t) => t)
  const publish = (tiles: number[] = all) => view.apply(pub.publish(tiles, cols)!)
  return { b, cols, pub, view, publish, set }
}

function at(view: SurfaceView, x: number, z: number, field: 'hCur' | 'hPrev' | 'info'): number[] {
  const d = view.column((x >> 5) + (z >> 5) * view.cx)!
  const o = ((x & 31) + (z & 31) * 32) * 4
  return [...d[field].subarray(o, o + 4)]
}

describe('SurfaceView', () => {
  it('draws a lake as a plane at its surface, leaving out the ground far below its edge', () => {
    const { view, publish } = scene(32, 32, () => 2, (x, z) => (x >= 4 && x <= 27 && z >= 4 && z <= 27 ? 3 * SUB : 0))
    expect(publish()).toBe(true)
    expect(at(view, 10, 10, 'hCur')).toEqual([5, 5, 5, 5])
    expect(at(view, 4, 10, 'hCur')).toEqual([5, 5, 5, 5])
    expect(at(view, 10, 10, 'info')).toEqual([0, 0, 3, LIT])
  })

  it('allocates nothing for a chunk column without water, and hides dry columns', () => {
    const { view, publish } = scene(64, 32, () => 2, (x, z) => (x < 20 && z < 20 ? SUB : 0))
    publish()
    expect(view.column(1)).toBeUndefined()
    expect(at(view, 25, 25, 'info')[3]).toBe(-1)
  })

  it('thins a film\'s edge toward lower dry ground within a block', () => {
    const { view, publish } = scene(32, 32, () => 2, (x) => (x <= 10 ? SUB / 4 : 0))
    publish()
    expect(at(view, 10, 5, 'hCur')).toEqual([2.25, 2.125, 2.125, 2.25])
  })

  it('leaves higher ground (a wall) out of the corners', () => {
    const { view, publish } = scene(32, 32, (x) => (x <= 10 ? 2 : 10), (x) => (x <= 10 ? 2 * SUB : 0))
    publish()
    expect(at(view, 10, 5, 'hCur')).toEqual([4, 4, 4, 4])
  })

  it('hangs a curtain from a ledge down to the water below, with the edge\'s flux, and white water at its foot', () => {
    const s = scene(32, 32, (x) => (x <= 10 ? 6 : 2), () => SUB)
    for (let z = 0; z < 32; z++) s.cols.flux[2 * (10 + z * 32)] = 16 * 20 // 20 sub per step over the ledge
    s.publish()
    const cs = s.view.column(0)!.curtains
    expect(cs.count).toBe(32)
    const k = [...Array(cs.count).keys()].find((i) => cs.info[i * 4] === 10 && cs.info[i * 4 + 1] === 5)!
    expect([...cs.cur.subarray(k * 4, k * 4 + 4)]).toEqual([7, 7, 3, 3])
    expect([...cs.prev.subarray(k * 4, k * 4 + 4)]).toEqual([7, 7, 3, 3])
    expect([...cs.info.subarray(k * 4, k * 4 + 4)]).toEqual([10, 5, 0 + 4 * LIT, 20])
    expect(at(s.view, 11, 5, 'info')[3]).toBe(LIT + 256) // white water 1 = 20 >> 4
  })

  it('matches corners across a chunk-column border', () => {
    const { view, publish } = scene(64, 32, () => 2, (x) => (x >= 20 && x <= 45 ? 2 * SUB : 0))
    publish()
    expect(at(view, 31, 10, 'hCur')[1]).toBe(at(view, 32, 10, 'hCur')[0])
    expect(at(view, 31, 10, 'hCur')[1]).toBe(4)
  })

  it('raises a column that just got wet from its ground, and sinks one that dried while still drawing it', () => {
    const s = scene(32, 32, () => 2, () => 0)
    s.publish()
    s.set(() => 2, (x, z) => (x === 10 && z === 10 ? 2 * SUB : 0))
    s.publish([0])
    const ground = Math.fround(2 - SINK)
    expect(at(s.view, 10, 10, 'hPrev')).toEqual([ground, ground, ground, ground])
    expect(at(s.view, 10, 10, 'hCur')).toEqual([4, 4, 4, 4])
    s.set(() => 2, () => 0)
    s.publish([0])
    expect(at(s.view, 10, 10, 'hPrev')).toEqual([4, 4, 4, 4])
    expect(at(s.view, 10, 10, 'hCur')).toEqual([ground, ground, ground, ground])
    expect(at(s.view, 10, 10, 'info')[3]).toBeGreaterThanOrEqual(0)
  })

  it('keeps the tiles of a tick whose buffer was reused, and reads them from the next tick\'s complete buffer', () => {
    const s = scene(32, 32, () => 2, () => SUB)
    const t1 = s.pub.publish([0], s.cols)!
    s.cols.depth[20 + 5 * 32] = 3 * SUB // tile 1 changes
    s.pub.publish([1], s.cols)
    s.cols.depth[5 + 20 * 32] = 4 * SUB // tile 2 changes; publish 3 reuses publish 1's buffer
    const t3 = s.pub.publish([2], s.cols)!
    expect(s.view.apply(t1)).toBe(false)
    expect(s.view.apply(t3)).toBe(true) // tiles 0, 1 and 2, from publish 3's buffer
    expect(at(s.view, 5, 5, 'hCur')).toEqual([3, 3, 3, 3])
    expect(at(s.view, 20, 5, 'hCur')).toEqual([5, 5, 5, 5])
    expect(at(s.view, 5, 20, 'hCur')).toEqual([6, 6, 6, 6])
  })

  it('drops a copy torn by a publish starting under it, and reads those tiles from the next tick', () => {
    const s = scene(32, 32, () => 2, () => SUB)
    s.publish()
    s.cols.depth[5 + 5 * 32] = 3 * SUB
    const t2 = s.pub.publish([0], s.cols)!
    const stamp = new Int32Array(s.b.stamp), surface = new Int32Array(s.b.surface)
    // The writer reuses t2's buffer right after the reader's first stamp check: it scribbles over tile 0 mid-copy.
    const load = Atomics.load
    const firstCheck = (a: Int32Array, i: number): number => {
      const v = load(a, i)
      Atomics.store(stamp, t2.parity, -1)
      surface[t2.parity * 32 * 32 + 5 + 5 * 32] = 99 * SUB
      return v
    }
    const spy = vi.spyOn(Atomics, 'load').mockImplementationOnce(firstCheck as unknown as typeof Atomics.load)
    try {
      expect(s.view.apply(t2)).toBe(false)
    } finally { spy.mockRestore() }
    expect(at(s.view, 5, 5, 'hCur')).toEqual([3, 3, 3, 3]) // nothing torn or stale applied
    s.cols.depth[20 + 5 * 32] = 4 * SUB
    expect(s.view.apply(s.pub.publish([1], s.cols)!)).toBe(true) // tiles 0 and 1, complete
    expect(at(s.view, 5, 5, 'hCur')).toEqual([5, 5, 5, 5])
    expect(at(s.view, 20, 5, 'hCur')).toEqual([6, 6, 6, 6])
  })

  it('hands each changed chunk column to the renderer once', () => {
    const { view, publish } = scene(64, 32, () => 2, (x) => (x < 40 ? SUB : 0))
    publish()
    expect(view.takeDirty()).toEqual([0, 1])
    expect(view.takeDirty()).toEqual([])
  })
})

describe('quantizeFlow', () => {
  it('quantizes the ripple flow to 8 directions and still / gentle / steep', () => {
    const out = new Float32Array(2)
    expect(quantizeFlow(0.1, 0, out, 0)).toBeCloseTo(0.1)
    expect([...out]).toEqual([0, 0])
    quantizeFlow(2, 0, out, 0)
    expect([...out]).toEqual([2.5, 0])
    quantizeFlow(0.5, 0.5, out, 0)
    expect(out[0]).toBeCloseTo(Math.SQRT1_2)
    expect(out[1]).toBeCloseTo(Math.SQRT1_2)
  })
})
