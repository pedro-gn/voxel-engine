import { describe, expect, it, vi } from 'vitest'
import {
  ARC_COLUMNS, ARC_GAP, ARC_REACH, ARC_SEGMENTS, CURTAIN_BOTTOM, CURTAIN_TOP, DIR_X, DIR_Z, END_X, END_Z, JOIN, SINK, arcPoint,
  cornerHeights, curtainAt, exitSpeed, layArc, level, quantizeFlow, shows,
} from '../src/render/water/surfaceMesh.ts'
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
    const r = Math.fround(flat(exitSpeed(20, 20), 7, 3)[0])
    expect(r).toBeGreaterThan(0)
    expect([...cs.reach.subarray(k * 4, k * 4 + 4)]).toEqual([r, r, r, r]) // thrown out with the flow: both ends, both steps
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
    expect(view.takeDirty()).toBe(view.takeDirty()) // nothing new: no fresh array per frame
  })

  it('settles a tile first applied through recovery on the next successful apply', () => {
    const s = scene(32, 32, () => 2, () => SUB)
    s.publish()
    s.cols.depth[5 + 5 * 32] = 3 * SUB // tile 0 changes at publish k
    const k = s.pub.publish([0], s.cols)!
    s.cols.depth[20 + 5 * 32] = 3 * SUB
    const k1 = s.pub.publish([1], s.cols)!
    s.cols.depth[5 + 20 * 32] = 3 * SUB
    const k2 = s.pub.publish([2], s.cols)! // reuses k's buffer; lists tiles 1 and 2 only
    expect(s.view.apply(k)).toBe(false)
    expect(s.view.apply(k1)).toBe(true)
    expect(s.view.apply(k2)).toBe(true)
    expect(at(s.view, 5, 5, 'hPrev')).toEqual([5, 5, 5, 5])
    expect(at(s.view, 5, 5, 'hCur')).toEqual([5, 5, 5, 5])
    expect(at(s.view, 20, 5, 'hPrev')).toEqual([5, 5, 5, 5])
  })

  it('gives neighbouring quads the same corners on a diagonal slope (no crack without a curtain)', () => {
    const s = scene(32, 32, () => 2, (x, z) => SUB + Math.round(0.8 * SUB * (x + z)))
    s.publish()
    expect(cracks(s.view, s.cols.floor)).toEqual([])
    expect(s.view.column(0)!.curtains.count).toBe(0)
  })

  it('gives neighbouring quads the same corners along a sloped shoreline', () => {
    // The film rises 7/8 block per column along x; the dry ground beside it (z > 10) lies within JOIN of the low end only.
    const s = scene(32, 32, () => 2, (x, z) => (z <= 10 && x < 4 ? SUB / 4 + 224 * x : 0))
    s.publish()
    expect(cracks(s.view, s.cols.floor)).toEqual([])
  })

  it('takes only the columns inside the world at its border', () => {
    const { view, publish } = scene(32, 32, () => 2, (x) => (x === 0 ? SUB / 4 : 0))
    publish()
    expect(at(view, 0, 5, 'hCur')).toEqual([2.25, 2.125, 2.125, 2.25])
    expect(at(view, 0, 0, 'hCur')).toEqual([2.25, 2.125, 2.125, 2.25])
    expect(at(view, 0, 31, 'hCur')).toEqual([2.25, 2.125, 2.125, 2.25])
  })

  it('writes the quantized flow and depth into info; a fast current a block deep stays clear', () => {
    const s = scene(32, 32, () => 2, () => SUB)
    const fx = (x: number, z: number, v: number) => { s.cols.flux[2 * (x + z * 32)] = v * 16 }
    const fz = (x: number, z: number, v: number) => { s.cols.flux[2 * (x + z * 32) + 1] = v * 16 }
    fx(9, 5, 64); fx(10, 5, 64) // 64 sub per step through both x edges: 5 blocks/s, steep
    fz(20, 19, -4); fz(20, 20, -4) // 0.3125 blocks/s toward −z: gentle
    fx(24, 10, 64); fx(25, 10, 64); fz(25, 9, 64); fz(25, 10, 64) // diagonal, 7.07 blocks/s
    s.publish()
    expect(at(s.view, 10, 5, 'info')).toEqual([2.5, 0, 1, LIT]) // Froude 5 / √9.8 = 1.6: no white water
    const g = at(s.view, 20, 20, 'info')
    expect(g[0]).toBeCloseTo(0)
    expect(g[1]).toBeCloseTo(-1)
    expect(g.slice(2)).toEqual([1, LIT])
    const d = at(s.view, 25, 10, 'info')
    expect(d[0]).toBeCloseTo(2.5 * Math.SQRT1_2)
    expect(d[1]).toBeCloseTo(2.5 * Math.SQRT1_2)
    expect(d.slice(2)).toEqual([1, LIT])
  })
})

/** Index of the curtain of column (lx, lz) of chunk column `cc` through side `dir`. */
function curtainIndex(view: SurfaceView, cc: number, lx: number, lz: number, dir = 0): number {
  const cs = view.column(cc)!.curtains
  for (let k = 0; k < cs.count; k++) if (cs.info[k * 4] === lx && cs.info[k * 4 + 1] === lz && cs.info[k * 4 + 2]! % 4 === dir) return k
  throw new Error(`no curtain at (${lx}, ${lz}) dir ${dir}`)
}

/** layArc over ground at `level` everywhere ahead: [reach, foot]. */
function flat(v: number, top: number, lv: number): number[] {
  const out = new Float64Array(2), l = Array<number>(ARC_COLUMNS).fill(lv)
  layArc(v, top, l, l, l, out)
  return [...out]
}

/** layArc over ground at `levels` (near = far = level): [reach, foot]. */
function over(v: number, top: number, levels: number[]): number[] {
  const out = new Float64Array(2)
  layArc(v, top, levels, levels, levels, out)
  return [...out]
}

/** Points of the arc (top, foot, reach) that lie below the level of the column under them (`levels`, 0 = the neighbour). */
function cuts(top: number, foot: number, r: number, levels: ArrayLike<number>): string[] {
  const p = new Float64Array(2), bad: string[] = []
  for (let k = 0; k <= 256; k++) {
    arcPoint(top, foot, r, k / 256, p, 0)
    const i = Math.floor(p[0]!)
    if (i < levels.length && p[1]! < levels[i]! - 1e-9) bad.push(`u ${p[0]!.toFixed(3)} y ${p[1]!.toFixed(3)} < ${levels[i]}`)
  }
  return bad
}

describe('curtain arcs', () => {
  it('maps the measured flows to exit speeds that grow with the flow, the cap only a guard', () => {
    // The calibration table of exitSpeed: (flux, drop) → reach over flat ground.
    const reach = (flux: number, drop: number) => flat(exitSpeed(flux, 20), 20, 20 - drop)[0]!
    expect(exitSpeed(64, 20)).toBe(1) // 0.125 · √flux blocks/s at 20 steps per second
    expect(reach(0, 4)).toBe(0)
    expect(reach(8, 4)).toBeCloseTo(0.22, 2) // a trickle stays close to the wall
    expect(reach(110, 15)).toBeCloseTo(1.61, 2) // one removed dam block
    expect(reach(210, 14)).toBeCloseTo(2.14, 2) // a breach
    expect(reach(480, 12)).toBeCloseTo(3, 2) // the dam column: the largest flow measured just reaches the cap
    expect(reach(32, 4) / reach(8, 4)).toBeCloseTo(2, 5) // the square root of the flow
    expect(reach(8, 9)).toBeGreaterThan(reach(8, 4)) // a higher fall lands farther out
    expect(reach(2000, 15)).toBe(ARC_REACH)
  })

  it('lands a single removed dam block visibly shorter than a wide breach', () => {
    const block = flat(exitSpeed(110, 20), 24, 9)[0]!, breach = flat(exitSpeed(400, 20), 22, 10)[0]!
    expect(breach - block).toBeGreaterThan(1)
  })

  it('keeps the drawn arc above every column it crosses, over stepped ground and the dam\'s valley', () => {
    const grounds: [number, number[]][] = [
      [10, [8, 6, 4, 2]], [10, [6, 4, 2, 0]], [10, [6, 4, 2, 2]], [24, [10.5, 10.5, 10.5, 9.5]], [7, [3, 6.9, 3, 3]],
      [7, [3, 4, 3, 3]], [12, [3, 9, 3, 3]], [12, [3, 3, 3, 11]], [7, [3, Infinity, 3, 3]],
    ]
    for (const [top, levels] of grounds) for (const flux of [0, 8, 32, 75, 110, 210, 480, 2000]) {
      const [r, foot] = over(exitSpeed(flux, 20), top, levels)
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThanOrEqual(ARC_REACH)
      expect(cuts(top, foot!, r!, levels), `top ${top} over ${levels} at flux ${flux}`).toEqual([])
    }
  })

  it('lands where the free fall meets the ground, and ends short of a wall ahead and of the world\'s border', () => {
    const v = exitSpeed(480, 20)
    const [r, foot] = over(v, 10, [8, 6, 4, 2])
    // Over the neighbour (level 8) and onto the next step: the free arc comes down to its level 6 at 1.73 blocks, inside it.
    expect(foot).toBe(6)
    expect(r).toBeCloseTo(v * Math.sqrt((2 * 4) / 20), 9)
    expect(over(exitSpeed(110, 20), 24, [10.5, 10.5, 10.5, 9.5])[1]).toBe(10.5) // the dam's valley: on the near bank
    expect(over(v, 10, [3, 3, 9.9, 3])).toEqual([2 - 2 * ARC_GAP, 3]) // a wall two columns past the neighbour, in the way
    expect(over(v, 7, [3, Infinity, 3, 3])).toEqual([1 - 2 * ARC_GAP, 3]) // outside the world
  })

  it('lays the arc from the top on the wall\'s plane, in front of the wall below it, down to its foot', () => {
    const p = new Float64Array(2)
    for (const r of [0, 0.4, ARC_REACH]) {
      let u0 = -1, y0 = Infinity
      for (let k = 0; k <= ARC_SEGMENTS; k++) {
        arcPoint(7, 3, r, k / ARC_SEGMENTS, p, 0)
        if (k === 0) expect([...p]).toEqual([0, 7]) // joins the upper surface's edge, above the wall
        else expect(p[0]).toBeGreaterThanOrEqual(ARC_GAP) // never on or behind the wall's plane, even with no flow
        expect(p[0]).toBeGreaterThanOrEqual(u0)
        expect(p[1]).toBeLessThan(y0)
        u0 = p[0]!
        y0 = p[1]!
      }
      expect([...p]).toEqual([ARC_GAP + r, 3])
    }
  })

  it('throws a curtain out with its flow and lands it on the water below', () => {
    const s = scene(32, 32, (x) => (x <= 10 ? 6 : 2), () => SUB)
    for (let z = 0; z < 32; z++) s.cols.flux[2 * (10 + z * 32)] = 16 * (z < 16 ? 480 : 4)
    s.publish()
    const cs = s.view.column(0)!.curtains
    const big = curtainIndex(s.view, 0, 10, 5), small = curtainIndex(s.view, 0, 10, 20)
    const r = Math.fround(flat(exitSpeed(480, 20), 7, 3)[0]!)
    expect([...cs.reach.subarray(big * 4 + 2, big * 4 + 4)]).toEqual([r, r])
    expect(r).toBeGreaterThan(1)
    expect(cs.reach[small * 4 + 2]).toBeLessThan(0.25)
    for (const k of [big, small]) expect([...cs.cur.subarray(k * 4, k * 4 + 4)]).toEqual([7, 7, 3, 3]) // feet on the lake
  })

  it('shares each end with the curtain beside it, so a wide fall has no seams where the flow changes', () => {
    const s = scene(32, 32, (x) => (x <= 10 ? 6 : 2), () => SUB)
    for (let z = 0; z < 32; z++) s.cols.flux[2 * (10 + z * 32)] = 16 * (z < 16 ? 8 : 200)
    s.publish()
    const cs = s.view.column(0)!.curtains, lo = curtainIndex(s.view, 0, 10, 15), hi = curtainIndex(s.view, 0, 10, 16)
    // Curtain (10, 15)'s end B and (10, 16)'s end A are the same vertex: same top, foot and reach, so the same arc.
    expect([cs.cur[lo * 4 + 1], cs.cur[lo * 4 + 3], cs.reach[lo * 4 + 3]]).toEqual([cs.cur[hi * 4], cs.cur[hi * 4 + 2], cs.reach[hi * 4 + 2]])
    // That end is thrown with both curtains' mean exit speed: farther than the weak side's other end, shorter than the strong's.
    expect(cs.reach[lo * 4 + 3]).toBeGreaterThan(cs.reach[lo * 4 + 2]!)
    expect(cs.reach[hi * 4 + 2]).toBeLessThan(cs.reach[hi * 4 + 3]!)
    expect(cs.reach[lo * 4 + 3]).toBe(Math.fround(flat((exitSpeed(8, 20) + exitSpeed(200, 20)) / 2, 7, 3)[0]!))
  })

  it('ends a curtain before a wall ahead, on the water in front of it', () => {
    const s = scene(32, 32, (x) => (x <= 10 ? 9 : x <= 12 ? 2 : 10), (x) => (x <= 12 ? SUB : 0))
    for (let z = 0; z < 32; z++) s.cols.flux[2 * (10 + z * 32)] = 16 * 480
    s.publish()
    const cs = s.view.column(0)!.curtains, k = curtainIndex(s.view, 0, 10, 5)
    expect([...cs.reach.subarray(k * 4 + 2, k * 4 + 4)]).toEqual([2 - 2 * ARC_GAP, 2 - 2 * ARC_GAP].map(Math.fround))
    expect([...cs.cur.subarray(k * 4, k * 4 + 4)]).toEqual([10, 10, 3, 3])
  })

  it('keeps each end of every curtain above the ground it crosses, its own top checked on its own', () => {
    // A sloping upper sheet (the ends' tops differ) over stepped dry ground, with a wall across every fifth row.
    const floor = (x: number, z: number) => (x <= 10 ? 20 : x === 13 && z % 5 === 0 ? 19 : Math.max(2, 18 - 2 * (x - 11)))
    const s = scene(32, 32, floor, (x, z) => (x <= 10 ? SUB + z * 20 : 0))
    for (let z = 0; z < 32; z++) s.cols.flux[2 * (10 + z * 32)] = 16 * (((z * 37) % 480) + 1)
    s.publish()
    expect(fromScratch(s.view, s.cols.floor)).toEqual([])
    const cs = s.view.column(0)!.curtains
    let checked = 0
    for (let z = 0; z < 32; z++) {
      const k = curtainIndex(s.view, 0, 10, z)
      for (let end = 0; end < 2; end++) {
        const top = cs.cur[k * 4 + end]!, foot = cs.cur[k * 4 + 2 + end]!, r = cs.reach[k * 4 + 2 + end]!
        const levels = [11, 12, 13, 14].map((x) => level(s.view.cur[x + z * 32]!) / SUB)
        expect(cuts(top, foot, r, levels), `(10, ${z}) end ${end}`).toEqual([])
        checked++
      }
      if (z > 0) expect(cs.cur[k * 4]).not.toBe(cs.cur[k * 4 + 1]) // the ends' tops differ
    }
    expect(checked).toBe(64)
  })

  it('lands across a chunk-column border, and follows the water there when only it changes', () => {
    const s = scene(64, 32, (x) => (x <= 29 ? 25 : 2), () => SUB)
    for (let z = 0; z < 32; z++) s.cols.flux[2 * (29 + z * 64)] = 16 * 480
    s.publish()
    const cs = s.view.column(0)!.curtains
    let k = curtainIndex(s.view, 0, 29, 5)
    expect(cs.reach[k * 4 + 2]).toBe(ARC_REACH) // lands in column 33, in chunk column 1
    expect([...cs.cur.subarray(k * 4, k * 4 + 4)]).toEqual([26, 26, 3, 3])
    for (let z = 0; z < 32; z++) for (let x = 33; x < 64; x++) s.cols.depth[x + z * 64] = 2 * SUB
    expect(s.publish([2, 3, 6, 7])).toBe(true) // chunk column 1 only: nothing within a column of chunk column 0 changes
    expect(fromScratch(s.view, s.cols.floor)).toEqual([])
    k = curtainIndex(s.view, 0, 29, 5)
    expect(cs.cur[k * 4 + 2]).toBeGreaterThan(3.5) // its feet rose with the water they land on
  })
})

describe('SurfaceView, white water', () => {
  /** White water (0–15) of column (10, 5) of a uniform sheet `depth` sub deep, running toward +x at `speed` blocks/s. */
  function whiteOf(depth: number, speed: number, dryPast = 32): number {
    const s = scene(32, 32, () => 2, (x) => (x < dryPast ? depth : 0))
    // speed = (west + east) × 20 / (2 × depth) with both edges carrying v sub per step.
    const v = Math.round((speed * depth) / 20)
    s.cols.flux[2 * (9 + 5 * 32)] = v * 16
    s.cols.flux[2 * (10 + 5 * 32)] = v * 16
    s.publish()
    return Math.floor(at(s.view, 10, 5, 'info')[3]! / 256)
  }

  it('leaves a steady 12 blocks/s stream at its depth (half a block, the flood river\'s flow) clear', () => {
    expect(whiteOf(SUB / 2, 12)).toBe(0)
    expect(whiteOf((SUB * 3) / 4, 8)).toBe(0) // the deep end of a river step
  })

  it('gives the shallow fast lip of a river step a light white edge', () => {
    const w = whiteOf(77, 20) // 0.3 block at 20 blocks/s
    expect(w).toBeGreaterThan(0)
    expect(w).toBeLessThanOrEqual(5)
  })

  it('whitens a shallow fast sheet', () => {
    expect(whiteOf(SUB / 8, 20)).toBeGreaterThanOrEqual(8)
  })

  it('whitens a sheet running fast onto dry ground (a bore front), and not a slow one', () => {
    expect(whiteOf(SUB / 8, 5, 11)).toBeGreaterThanOrEqual(6) // the dam break's front a second after the breach
    expect(whiteOf(SUB / 8, 1, 11)).toBe(0) // a film creeping on
    expect(whiteOf(SUB / 8, 5)).toBe(0) // the same sheet with water ahead
  })

  it('does not count a wall ahead as dry ground', () => {
    const s = scene(32, 32, (x) => (x <= 10 ? 2 : 10), (x) => (x <= 10 ? SUB / 8 : 0))
    s.cols.flux[2 * (9 + 5 * 32)] = 8 * 16 // 5 blocks/s, as in the bore test
    s.cols.flux[2 * (10 + 5 * 32)] = 8 * 16
    s.publish()
    expect(Math.floor(at(s.view, 10, 5, 'info')[3]! / 256)).toBe(0)
  })
})

describe('SurfaceView, incremental', () => {
  it('matches corners and curtains computed from scratch, through random changes, ledges and falling behind', () => {
    let seed = 7
    const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
    const S = 64, T = S / 16
    const s = scene(S, S, (x, z) => 2 + (((x >> 3) + (z >> 2)) % 3) * ((x + z) % 7 === 0 ? 2 : 1), () => 0)
    const { cols, pub, view } = s
    for (let c = 0; c < S * S; c++) cols.depth[c] = rand() < 0.6 ? Math.floor(rand() * 3 * SUB) : 0
    // Half the tiles come in later, through random changes: their first apply refreshes around them from scratch.
    view.apply(pub.publish(Array.from({ length: T * T / 2 }, (_, t) => 2 * t), cols)!)
    const queue: ReturnType<typeof pub.publish>[] = []
    let checks = 0
    for (let tick = 0; tick < 80; tick++) {
      const changed = new Set<number>()
      const n = 1 + Math.floor(rand() * 4)
      for (let m = 0; m < n; m++) {
        const tile = Math.floor(rand() * T * T), x0 = (tile % T) * 16, z0 = Math.floor(tile / T) * 16
        changed.add(tile)
        for (let z = z0; z < z0 + 16; z++) for (let x = x0; x < x0 + 16; x++) {
          const c = x + z * S, r = rand()
          cols.depth[c] = r < 0.1 ? 0 : r < 0.2 ? 2 * SUB : Math.max(0, cols.depth[c]! + Math.floor((rand() - 0.5) * 160))
          cols.flux[2 * c] = Math.floor((rand() - 0.5) * 1000)
          cols.flux[2 * c + 1] = Math.floor((rand() - 0.5) * 1000)
        }
      }
      queue.push(pub.publish([...changed].sort((a, b) => a - b), cols))
      if (rand() < 0.15) continue // fall behind: the next apply may find this buffer reused
      for (const t of queue.splice(0)) if (t && view.apply(t)) { expect(fromScratch(view, cols.floor)).toEqual([]); checks++ }
    }
    expect(checks).toBeGreaterThan(50)
  }, 20_000)
})

describe('SurfaceView, displayed alpha', () => {
  /** A lake (floor 2) or a ledge (floor 6, x ≤ 10) over it; `step(depth, alpha)` sets the lake's depth, publishes and applies. */
  function rising(ledge: boolean) {
    const s = scene(32, 32, (x) => (ledge && x <= 10 ? 6 : 2), () => SUB)
    const step = (depth: number, alpha?: number) => {
      for (let z = 0; z < 32; z++) for (let x = ledge ? 11 : 0; x < 32; x++) s.cols.depth[x + z * 32] = depth
      expect(s.view.apply(s.pub.publish([0, 1, 2, 3], s.cols)!, alpha)).toBe(true)
    }
    step(SUB)
    step(2 * SUB) // prev 3, cur 4: drawn at 3.6 at alpha 0.6
    return { ...s, step }
  }
  /** Corner k of column (x, z) as drawn at alpha `a`. */
  const drawn = (view: SurfaceView, x: number, z: number, a: number) => {
    const p = at(view, x, z, 'hPrev'), c = at(view, x, z, 'hCur')
    return p.map((v, k) => v + (c[k]! - v) * a)
  }

  it('starts each step from the height on screen, not from the previous step', () => {
    const { view, step } = rising(false)
    const before = drawn(view, 10, 10, 0.6)
    for (const v of before) expect(v).toBeCloseTo(3.6, 5)
    step(3 * SUB, 0.6)
    expect(drawn(view, 10, 10, 0)).toEqual(before.map(Math.fround)) // no jump at the publish
    expect(at(view, 10, 10, 'hCur')).toEqual([5, 5, 5, 5])
  })

  it('starts a curtain from where it is drawn too', () => {
    const { view, step } = rising(true)
    const d = view.column(0)!
    const curtain = (i: number) => [...d.curtains.prev.subarray(i * 4, i * 4 + 4)].map((v, k) => v + (d.curtains.cur[i * 4 + k]! - v) * 0.6)
    const before = curtain(0)
    expect(before[2]).toBeCloseTo(3.6, 5) // its bottom follows the lake
    step(3 * SUB, 0.6)
    expect([...d.curtains.prev.subarray(0, 4)]).toEqual(before.map(Math.fround))
    expect(d.curtains.cur[2]).toBe(5)
  })

  it('carries a curtain\'s reach from where it is drawn when its flow changes', () => {
    const s = scene(32, 32, (x) => (x <= 10 ? 6 : 2), () => SUB)
    const flow = (f: number, alpha?: number) => {
      for (let z = 0; z < 32; z++) s.cols.flux[2 * (10 + z * 32)] = 16 * f
      expect(s.view.apply(s.pub.publish([0, 1, 2, 3], s.cols)!, alpha)).toBe(true)
    }
    flow(8)
    flow(32, 0.6)
    const cs = s.view.column(0)!.curtains
    let k = curtainIndex(s.view, 0, 10, 5)
    expect(cs.reach[k * 4]).toBeLessThan(cs.reach[k * 4 + 2]!) // moving out with the stronger flow
    const before = [0, 1].map((e) => cs.reach[k * 4 + e]! + (cs.reach[k * 4 + 2 + e]! - cs.reach[k * 4 + e]!) * 0.6)
    flow(64, 0.6)
    k = curtainIndex(s.view, 0, 10, 5)
    expect([...cs.reach.subarray(k * 4, k * 4 + 2)]).toEqual(before.map(Math.fround)) // no jump at the publish
    const r = Math.fround(flat(exitSpeed(64, 20), 7, 3)[0]!)
    expect([...cs.reach.subarray(k * 4 + 2, k * 4 + 4)]).toEqual([r, r])
  })

  it('never moves backwards or past the newest step when two publishes come in one frame', () => {
    const { view, step } = rising(false)
    const before = drawn(view, 10, 10, 0.6)[0]!
    step(3 * SUB, 0.6)
    step(4 * SUB, 0) // the engine passes 0 after an apply: the new step starts where the last one was drawn
    expect(drawn(view, 10, 10, 0)[0]).toBe(Math.fround(before))
    expect(drawn(view, 10, 10, 1)[0]).toBe(6)
  })

  it('keeps computing the previous step from scratch when no alpha is given', () => {
    const { view, step } = rising(false)
    step(3 * SUB)
    expect(at(view, 10, 10, 'hPrev')).toEqual([4, 4, 4, 4])
  })

  /**
   * Tile 0's lake rises by a block and settles (its re-send) while drawn at alpha 0.6; then only `far` tiles publish, each
   * applied at alpha 0.5 (the alpha drawn just before). Returns, per later apply, how far `drawnAt` moved (`jumps`) and moved
   * back (`back`; the lake rises) between the frame before it (alpha 0.5) and right after it (alpha 0, as the engine draws).
   */
  function settleThenFar(
    sx: number, floor: (x: number) => number, far: number[], drawnAt: (view: SurfaceView, a: number) => number[], ledgeFlux = 0,
  ) {
    const s = scene(sx, 32, floor, () => SUB)
    for (let z = 0; z < 32; z++) s.cols.flux[2 * (10 + z * sx)] = 16 * ledgeFlux // over the ledge's edge, if it has one
    s.publish()
    s.publish([]) // loaded and settled
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) if (floor(x) === 2) s.cols.depth[x + z * sx] = 2 * SUB
    expect(s.view.apply(s.pub.publish([0], s.cols)!, 0.9)).toBe(true)
    expect(s.view.apply(s.pub.publish([], s.cols)!, 0.6)).toBe(true) // the settling re-send
    const jumps: number[] = [], back: number[] = []
    for (let n = 0; n < 12; n++) {
      const before = drawnAt(s.view, 0.5)
      // The far tiles change every time, so each apply refreshes them (and, around them, nothing near tile 0).
      for (const t of far) {
        const x0 = (t % (sx / 16)) * 16, z0 = Math.floor(t / (sx / 16)) * 16
        for (let z = z0; z < z0 + 16; z++) for (let x = x0; x < x0 + 16; x++) s.cols.depth[x + z * sx] = SUB + (n % 2) * 16
      }
      expect(s.view.apply(s.pub.publish(far, s.cols)!, 0.5)).toBe(true)
      const after = drawnAt(s.view, 0)
      jumps.push(Math.max(...before.map((v, k) => Math.abs(Math.fround(v) - after[k]!))))
      back.push(Math.max(...before.map((v, k) => Math.fround(v) - after[k]!)))
    }
    return { ...s, jumps, back }
  }

  it('moves a quad that settled before it was drawn to its end on to its end at the next applies, never back', () => {
    const { view, jumps, back } = settleThenFar(32, () => 2, [3], (v, a) => drawn(v, 5, 5, a))
    // Each apply starts it where it was drawn; the last one snaps it the rest of the way (under 1/256 block) to its end.
    expect(Math.max(...back)).toBeLessThanOrEqual(0)
    expect(Math.max(...jumps)).toBeLessThan(1 / 256)
    expect(at(view, 5, 5, 'hCur')).toEqual([4, 4, 4, 4])
    expect(at(view, 5, 5, 'hPrev')).toEqual([4, 4, 4, 4]) // and it reached its end
  })

  it('moves a curtain of a chunk column no later apply touches on to its end too, its reach included', () => {
    const curtain = (view: SurfaceView) => curtainIndex(view, 0, 10, 5)
    // Its heights, then its reach negated: the lake rises, so the fall gets shorter and lands closer (moving "back" is up).
    const drawnCurtain = (view: SurfaceView, a: number) => {
      const cs = view.column(0)!.curtains, k = curtain(view), o = k * 4
      const r = [0, 1].map((e) => cs.reach[o + e]! + (cs.reach[o + 2 + e]! - cs.reach[o + e]!) * a)
      return [...[0, 1, 2, 3].map((j) => cs.prev[o + j]! + (cs.cur[o + j]! - cs.prev[o + j]!) * a), -r[0]!, -r[1]!]
    }
    // Chunk column 0 holds the ledge and tile 0; tiles 3 and 7 lie in chunk column 1.
    const { view, jumps, back } = settleThenFar(64, (x) => (x <= 10 ? 6 : 2), [3, 7], drawnCurtain, 128)
    expect(Math.max(...back)).toBeLessThanOrEqual(0)
    expect(Math.max(...jumps)).toBeLessThan(1 / 256)
    const cs = view.column(0)!.curtains, k = curtain(view), o = k * 4
    expect(cs.cur[o + 2]).toBe(4) // its bottom: the risen lake
    expect([...cs.prev.subarray(o, o + 4)]).toEqual([...cs.cur.subarray(o, o + 4)])
    const r = Math.fround(flat(exitSpeed(128, 20), 7, 4)[0]!)
    expect([...cs.reach.subarray(o, o + 4)]).toEqual([r, r, r, r]) // ended: prev = cur, both ends
  })
})

/** Where the columns' corners or the chunk columns' curtains differ from cornerHeights and curtainAt on view.prev / cur. */
function fromScratch(view: SurfaceView, floor: Int16Array): string[] {
  const { sx, sz, prev, cur } = view
  const bad: string[] = []
  const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]
  const k = new Float32Array(16)
  for (let cc = 0; cc < view.cx * view.cz; cc++) {
    const d = view.column(cc)
    const x0 = (cc % view.cx) * 32, z0 = Math.floor(cc / view.cx) * 32
    const want: string[] = []
    for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
      const x = x0 + lx, z = z0 + lz, c = x + z * sx, o = (lx + lz * 32) * 4
      const drawn = shows(prev[c]!, floor[c]!) || shows(cur[c]!, floor[c]!)
      if (!drawn) { if (d && d.info[o + 3] !== -1) bad.push(`${x},${z} shown`); continue }
      if (!d || d.info[o + 3]! < 0) { bad.push(`${x},${z} hidden`); continue }
      cornerHeights(prev, floor, sx, sz, x, z, k, 0)
      cornerHeights(cur, floor, sx, sz, x, z, k, 4)
      if (!same(d.hPrev.subarray(o, o + 4), k.subarray(0, 4))) bad.push(`${x},${z} hPrev ${d.hPrev.subarray(o, o + 4)} vs ${k.subarray(0, 4)}`)
      if (!same(d.hCur.subarray(o, o + 4), k.subarray(4, 8))) bad.push(`${x},${z} hCur ${d.hCur.subarray(o, o + 4)} vs ${k.subarray(4, 8)}`)
      for (let dir = 0; dir < 4; dir++) {
        const dx = DIR_X[dir]!, dz = DIR_Z[dir]!, jx = x + dx, jz = z + dz
        if (jx < 0 || jz < 0 || jx >= sx || jz >= sz) continue
        const j = jx + jz * sx, was = curtainAt(prev, floor, c, j), now = curtainAt(cur, floor, c, j)
        if (!was && !now) continue
        const [ta, tb] = CURTAIN_TOP[dir]!
        // Expected (top A, top B, foot A, foot B, reach A, reach B) in a step; an absent curtain rolls up to its top.
        const lay = (s: Int32Array, o: number, on: boolean): number[] => {
          const a = k[o + ta]!, b = k[o + tb]!
          if (!on) return [a, b, a, b, 0, 0]
          const [ra, fa] = expectedEnd(view, floor, s, x, z, dir, 0, a), [rb, fb] = expectedEnd(view, floor, s, x, z, dir, 1, b)
          return [a, b, fa!, fb!, ra!, rb!]
        }
        const p = lay(prev, 0, was), q = lay(cur, 4, now)
        want.push(`${lx},${lz},${dir}: ${p.join(' ')} | ${q.join(' ')}`)
      }
    }
    const got: string[] = []
    if (d) {
      const cs = d.curtains
      for (let n = 0; n < cs.count; n++) {
        const o = n * 4
        const p = [...cs.prev.subarray(o, o + 4), ...cs.reach.subarray(o, o + 2)], q = [...cs.cur.subarray(o, o + 4), ...cs.reach.subarray(o + 2, o + 4)]
        got.push(`${cs.info[o]},${cs.info[o + 1]},${cs.info[o + 2]! % 4}: ${p.join(' ')} | ${q.join(' ')}`)
      }
    }
    if (got.join('/') !== want.join('/')) bad.push(`curtains of ${cc}: ${got.join('/')} vs ${want.join('/')}`)
  }
  return bad
}

/**
 * [reach, foot] of end `end` (0 A, 1 B) of the curtain from column (x, z) through side `dir` in step `s`, from scratch: thrown
 * at the mean exit speed of it and the curtain beside that end on the same side (if one hangs there in the step), over the
 * higher level of their two rows, onto this row's columns (their corners, or their ground when not drawn).
 */
function expectedEnd(view: SurfaceView, floor: Int16Array, s: Int32Array, x: number, z: number, dir: number, end: number, top: number): number[] {
  const { sx, sz } = view, dx = DIR_X[dir]!, dz = DIR_Z[dir]!, ox = END_X[dir]![end]!, oz = END_Z[dir]![end]!
  const speed = (c: number) => {
    const f = dir === 0 ? view.fluxX[c]! : dir === 1 ? -view.fluxX[c - 1]! : dir === 2 ? view.fluxZ[c]! : -view.fluxZ[c - sx]!
    return exitSpeed(Math.max(0, f), 20)
  }
  const inside = (ax: number, az: number) => ax >= 0 && az >= 0 && ax < sx && az < sz
  const nx = x + ox, nz = z + oz
  const shared = inside(nx, nz) && curtainAt(s, floor, nx + nz * sx, nx + dx + (nz + dz) * sx)
  const v = shared ? (speed(x + z * sx) + speed(nx + nz * sx)) / 2 : speed(x + z * sx)
  const levels: number[] = [], near: number[] = [], far: number[] = [], corners = new Float32Array(4)
  for (let i = 0; i < ARC_COLUMNS; i++) {
    const ax = x + dx * (i + 1), az = z + dz * (i + 1)
    if (!inside(ax, az)) { levels.push(Infinity); near.push(0); far.push(0); continue }
    const g = level(s[ax + az * sx]!) / SUB
    levels.push(shared ? Math.max(g, level(s[ax + ox + (az + oz) * sx]!) / SUB) : g)
    const drawn = cornerHeights(s, floor, sx, sz, ax, az, corners, 0)
    near.push(drawn ? corners[CURTAIN_BOTTOM[dir]![end]!]! : g)
    far.push(drawn ? corners[CURTAIN_TOP[dir]![end]!]! : g)
  }
  const out = new Float64Array(2)
  layArc(v, top, levels, near, far, out)
  return [Math.fround(out[0]!), Math.fround(out[1]!)]
}

/** Edge-adjacent drawn columns within JOIN of each other whose shared corners differ: "x,z +x|+z: a vs b". */
function cracks(view: SurfaceView, floor: Int16Array): string[] {
  const out: string[] = []
  const h = (x: number, z: number, k: number) => at(view, x, z, 'hCur')[k]!
  for (let z = 0; z < view.sz; z++) for (let x = 0; x < view.sx; x++) {
    const c = x + z * view.sx
    if (!shows(view.cur[c]!, floor[c]!)) continue
    const pairs: [number, number, number, number, number, number][] = [
      [x + 1, z, 1, 0, 2, 3], // +x neighbour: my (+x,−z) = its (−x,−z), my (+x,+z) = its (−x,+z)
      [x, z + 1, 3, 0, 2, 1], // +z neighbour: my (−x,+z) = its (−x,−z), my (+x,+z) = its (+x,−z)
    ]
    for (const [jx, jz, a1, b1, a2, b2] of pairs) {
      if (jx >= view.sx || jz >= view.sz) continue
      const j = jx + jz * view.sx
      if (!shows(view.cur[j]!, floor[j]!) || Math.abs(view.cur[j]! - view.cur[c]!) > JOIN) continue
      if (h(x, z, a1) !== h(jx, jz, b1) || h(x, z, a2) !== h(jx, jz, b2)) {
        out.push(`${x},${z} ${jx > x ? '+x' : '+z'}: ${h(x, z, a1)},${h(x, z, a2)} vs ${h(jx, jz, b1)},${h(jx, jz, b2)}`)
      }
    }
  }
  return out
}

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

describe('SurfaceView.relight', () => {
  /** A ledge (floor 6, x ≤ 10) over a lake (floor 2), both a block deep, lit by `light`. */
  function ledge(light: (x: number, y: number, z: number) => number) {
    const b = createWaterBuffers([32, 32, 32])
    const cols = new WaterColumns(32, 32, new Int16Array(b.floor))
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) { cols.floor[x + z * 32] = x <= 10 ? 6 : 2; cols.depth[x + z * 32] = SUB }
    const view = new SurfaceView([32, 32, 32], b, light)
    view.apply(new WaterPublisher(b).publish(Array.from({ length: cols.tiles.count }, (_, t) => t), cols)!)
    view.takeDirty()
    const d = view.column(0)!
    d.rowLo = 32
    d.rowHi = -1
    return { view, d }
  }

  it('re-reads the light of the drawn columns whose light cell lies in the given layers, keeping their white water', () => {
    let torch = 0
    const { view, d } = ledge((x, _y, z) => SKY15 | ((x === 20 && z === 7 ? torch : 0) << 4))
    view.relight(0, 0, 32)
    expect(view.takeDirty()).toEqual([]) // nothing changed
    torch = 12
    d.info[(20 + 7 * 32) * 4 + 3] = 3 * 256 + LIT // white water 3
    view.relight(0, 8, 32) // the lake's light cell (y 3) is not in these layers
    expect(view.takeDirty()).toEqual([])
    view.relight(0, 0, 8)
    expect(view.takeDirty()).toEqual([0])
    expect(at(view, 20, 7, 'info')[3]).toBe(3 * 256 + LIT + 12)
    expect(at(view, 21, 7, 'info')[3]).toBe(LIT)
    expect([d.rowLo, d.rowHi]).toEqual([7, 7])
  })

  it('re-lights the curtains hanging from a re-lit column', () => {
    let torch = 0
    const { view, d } = ledge((x) => SKY15 | ((x === 10 ? torch : 0) << 4))
    const curtainLight = () => [...d.curtains.info.subarray(2, 4 * d.curtains.count)].filter((_, i) => i % 4 === 0)
    expect(d.curtains.count).toBe(32)
    expect(curtainLight().every((v) => v === 4 * LIT)).toBe(true) // dir 0 (+x) + 4 × light
    torch = 9
    view.relight(0, 0, 32)
    expect(curtainLight().every((v) => v === 4 * (LIT + 9))).toBe(true)
    expect(view.takeDirty()).toEqual([0])
  })
})
