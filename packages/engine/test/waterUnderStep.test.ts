import { describe, expect, it } from 'vitest'
import { WaterColumns } from '../src/sim/water/columns.ts'
import { HEAD_EPS, SUB, TILE } from '../src/sim/water/constants.ts'
import { WaterEdges } from '../src/sim/water/edges.ts'
import { UnderSegments } from '../src/sim/water/under.ts'
import { LegacyColumns } from './legacy/columns3c.ts'
import { AIR, STONE, layered, wv } from './layerHelpers.ts'

/** The first index where two arrays differ, −1 when equal (toEqual on whole typed arrays every step is too slow). */
const diff = (x: ArrayLike<number>, y: ArrayLike<number>): number => {
  if (x.length !== y.length) return -2
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return i
  return -1
}

describe('the step with no lower segment is 3c step', () => {
  it('matches the frozen 3c step exactly, depth and flux, every step, free and throttled', () => {
    for (const [seed, cap] of [[1, 1 << 20], [2, 1 << 20], [3, 2], [4, 1]] as const) {
      let s = seed
      const rand = (k: number) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % k }
      const sx = 48, sz = 32
      const floor = new Int16Array(sx * sz), depth = new Int32Array(sx * sz)
      for (let c = 0; c < sx * sz; c++) { floor[c] = 2 + rand(6); depth[c] = rand(3) === 0 ? 0 : rand(4 * SUB) }
      const a = new WaterColumns(sx, sz, floor.slice()), b = new LegacyColumns(sx, sz, floor.slice())
      a.attach(new UnderSegments(a.n), new WaterEdges(a.tiles.count), 32)
      a.depth.set(depth); b.depth.set(depth)
      for (let t = 0; t < a.tiles.count; t++) { a.tiles.wake(t); b.tiles.wake(t) }
      for (let k = 0; k < 300; k++) {
        a.step(cap, null, 0); b.step(cap, null, 0)
        expect([k, diff(a.depth, b.depth), diff(a.flux, b.flux), diff(a.tiles.awake, b.tiles.awake)]).toEqual([k, -1, -1, -1])
      }
    }
  })
})

describe('water through under edges', () => {
  /** A lake (x 1–10, floor 2, water to y 5) beside a cave (x 11–20, cells y 2–3) under a roof; stone walls all round. */
  const lakeAndCave = (x: number, y: number, z: number) => {
    if (y < 2 || x === 0 || z === 0 || z >= 6 || x >= 21) return STONE
    if (x <= 10) return y <= 5 ? wv(7) : AIR
    return y <= 3 ? AIR : STONE
  }

  it('a lake pours into a cave beside it: the cave fills to its roof, never past it, and volume is exact', () => {
    const w = layered(lakeAndCave)
    const total = w.total()
    w.settle(30_000, 1 << 20, () => {
      for (let i = 0; i < w.under.count; i++) if (w.under.col[i]! >= 0) expect(w.under.depth[i]!).toBeLessThanOrEqual(w.under.cap(i))
    })
    // the cave ends full to its roof, within the heads a sleeping tile allows
    for (let x = 11; x <= 20; x++) expect(w.segs(x, 3)[0]!.depth).toBeGreaterThanOrEqual(2 * SUB - 2 * HEAD_EPS)
    expect(w.total()).toBe(total)
  })

  it('water flows under a bridge from one pool into the other and levels', () => {
    const w = layered((x, y, z) => {
      if (y < 2 || x === 0 || x === 31 || z === 0 || z >= 4) return STONE
      if (x === 15 && y === 7) return STONE // the bridge deck, above the water
      return x < 15 && y <= 5 ? wv(7) : AIR
    })
    const total = w.total()
    w.settle()
    expect(w.segs(15, 2)).toEqual([{ floor: 2, ceil: 7, depth: expect.any(Number) }, { floor: 8, ceil: 32, depth: 0 }])
    const left = w.cols.surface(5 + 2 * 32), right = w.cols.surface(25 + 2 * 32)
    expect(Math.abs(left - right)).toBeLessThanOrEqual(2 * HEAD_EPS)
    expect(w.total()).toBe(total)
  })

  it('water crossing an under edge into a tile that does not step reaches it (Review Focus 3)', () => {
    // The lake fills tile 0; the cave starts at x 16, in tile 1, which starts asleep.
    const w = layered((x, y, z) => {
      if (y < 2 || x === 0 || z === 0 || z >= 6 || x >= 30) return STONE
      if (x <= 15) return y <= 5 ? wv(7) : AIR
      return y <= 3 ? AIR : STONE
    })
    const t1 = w.cols.tiles.of(16, 3)
    expect(w.cols.tiles.awake[t1]).toBe(0)
    const total = w.total()
    let woke = false
    for (let k = 0; k < 20 && !woke; k++) { w.step(); woke = w.cols.tiles.awake[t1] === 1 }
    expect(woke).toBe(true)
    expect(w.segs(16, 3)[0]!.depth).toBeGreaterThan(0)
    expect(w.total()).toBe(total)
  })

  it('a still cave pool falls asleep and stays put', () => {
    const w = layered((x, y, z) => {
      if (y < 2 || y >= 6 || x === 0 || z === 0 || x >= TILE || z >= TILE) return STONE
      return y <= 3 ? wv(7) : AIR
    })
    const total = w.total()
    w.settle(200)
    expect(w.segs(5, 5)[0]).toMatchObject({ floor: 2, ceil: 6, depth: 2 * SUB })
    expect(w.total()).toBe(total)
  })
})
