import { describe, expect, it } from 'vitest'
import { KIND, SUB, UNIT } from '../src/sim/water/constants.ts'
import { resegment, runsOf, type Seg } from '../src/sim/water/resegment.ts'

const { AIR: A, WATER: W, WALL: L } = KIND
const H = 32
const TOP = -2

/** Cell kinds after the write: walls at the given heights, everything else air. */
const walls = (...ys: number[]) => (y: number) => (ys.includes(y) ? L : A)
/** Walls below `g` plus the given ones. */
const ground = (g: number, ...ys: number[]) => (y: number) => (y < g || ys.includes(y) ? L : A)
const top = (floor: number, depth: number): Seg => ({ floor, ceil: H, depth, id: TOP })
const seg = (id: number, floor: number, ceil: number, depth: number): Seg => ({ floor, ceil, depth, id })
const sum = (xs: { depth: number }[]) => xs.reduce((s, x) => s + x.depth, 0)

describe('runsOf', () => {
  it('lists the runs of non-wall cells bottom-up, the last reaching the height (empty under a wall at the top)', () => {
    expect(runsOf(H, walls(0, 5, 6, 9))).toEqual([
      { floor: 1, ceil: 5, depth: 0, id: -1 }, { floor: 7, ceil: 9, depth: 0, id: -1 }, { floor: 10, ceil: H, depth: 0, id: -1 },
    ])
    expect(runsOf(4, () => L)).toEqual([{ floor: 4, ceil: 4, depth: 0, id: -1 }])
  })
})

describe('resegment', () => {
  it('a wall on the top segment floor is 3c floor rise: depth unchanged, the cell water displaced (spread later)', () => {
    const r = resegment([top(2, 3 * SUB)], H, ground(3), 2, W, L, 0)
    expect(r.runs).toEqual([{ floor: 3, ceil: H, depth: 3 * SUB, id: TOP }])
    expect(r.topDisplaced).toBe(SUB)
  })

  it('a wall mid-water in the top splits it: water below stays as a new lower segment, the cell water is displaced', () => {
    const r = resegment([top(2, 4 * SUB)], H, ground(2, 4), 4, W, L, 0)
    expect(r.runs).toEqual([
      { floor: 2, ceil: 4, depth: 2 * SUB, id: -1 },
      { floor: 5, ceil: H, depth: SUB + SUB, id: TOP }, // one block above the wall + the displaced cell
    ])
    expect(r.topDisplaced).toBe(SUB)
  })

  it('a wall in the surface cell displaces only that cell water', () => {
    const r = resegment([top(2, 2 * SUB + 100)], H, ground(2, 4), 4, W, L, 0)
    expect(r.runs).toEqual([{ floor: 2, ceil: 4, depth: 2 * SUB, id: -1 }, { floor: 5, ceil: H, depth: 100, id: TOP }])
    expect(r.topDisplaced).toBe(100)
  })

  it('a wall above the surface (a bridge) splits the top: the lake becomes a lower segment, the top is dry', () => {
    const r = resegment([top(2, 3 * SUB)], H, ground(2, 8), 8, A, L, 0)
    expect(r.runs).toEqual([{ floor: 2, ceil: 8, depth: 3 * SUB, id: -1 }, { floor: 9, ceil: H, depth: 0, id: TOP }])
    expect(r.topDisplaced).toBe(0)
  })

  it('a wall in a lower segment: below stays, the cell goes up with the water above', () => {
    const r = resegment([seg(7, 2, 8, 5 * SUB), top(9, 0)], H, ground(2, 4, 8), 4, W, L, 0)
    expect(r.runs).toEqual([
      { floor: 2, ceil: 4, depth: 2 * SUB, id: 7 }, { floor: 5, ceil: 8, depth: 3 * SUB, id: -1 }, { floor: 9, ceil: H, depth: 0, id: TOP },
    ])
  })

  it('a wall in the top cell of a full lower segment pushes the cell water into the part below, over its capacity', () => {
    const r = resegment([seg(3, 2, 6, 4 * SUB), top(7, 0)], H, ground(2, 5, 6), 5, W, L, 0)
    expect(r.runs[0]).toEqual({ floor: 2, ceil: 5, depth: 4 * SUB, id: 3 }) // cap 3 blocks: 1 block of excess
    expect(sum(r.runs)).toBe(4 * SUB)
  })

  it('a wall filling a one-cell pocket sends its water to the top (spread)', () => {
    const r = resegment([seg(1, 3, 4, SUB), top(5, 0)], H, ground(5), 3, W, L, 0)
    expect(r.runs).toEqual([{ floor: 5, ceil: H, depth: SUB, id: TOP }])
    expect(r.topDisplaced).toBe(SUB)
  })

  it('digging the wall between a lower segment and the top merges them: the upper water falls onto the lower', () => {
    const r = resegment([seg(4, 2, 5, 2 * SUB), top(6, SUB)], H, ground(2), 5, L, A, 0)
    expect(r.runs).toEqual([{ floor: 2, ceil: H, depth: 3 * SUB, id: TOP }])
  })

  it('digging the wall between two lower segments merges them under the lower one identity', () => {
    const r = resegment([seg(4, 2, 5, 3 * SUB), seg(9, 6, 8, SUB), top(10, 0)], H, ground(2, 8, 9), 5, L, A, 0)
    expect(r.runs).toEqual([{ floor: 2, ceil: 8, depth: 4 * SUB, id: 4 }, { floor: 10, ceil: H, depth: 0, id: TOP }])
  })

  it('digging a roof cell grows the segment under it; digging a floor cell lowers it and keeps it', () => {
    const roof = resegment([seg(4, 2, 5, 3 * SUB), top(7, 0)], H, ground(2, 6), 5, L, A, 0)
    expect(roof.runs[0]).toEqual({ floor: 2, ceil: 6, depth: 3 * SUB, id: 4 })
    const floor = resegment([seg(4, 3, 6, SUB), top(7, 0)], H, ground(2, 6), 2, L, A, 0)
    expect(floor.runs[0]).toEqual({ floor: 2, ceil: 6, depth: SUB, id: 4 })
  })

  it('digging a cell inside a thick wall opens a new empty pocket', () => {
    const r = resegment([top(10, 0)], H, (y) => (y < 10 && y !== 5 ? L : A), 5, L, A, 0)
    expect(r.runs).toEqual([{ floor: 5, ceil: 6, depth: 0, id: -1 }, { floor: 10, ceil: H, depth: 0, id: TOP }])
  })

  it('water placed or removed by a command changes the segment holding the cell by exactly its share', () => {
    const placed = resegment([seg(4, 2, 8, SUB), top(9, 0)], H, ground(2, 8), 6, A, W, 3)
    expect(placed.runs[0]!.depth).toBe(SUB + 3 * UNIT)
    const removed = resegment([seg(4, 2, 8, 2 * SUB + 50), top(9, 0)], H, ground(2, 8), 4, W, A, 0)
    expect(removed.runs[0]!.depth).toBe(2 * SUB) // the surface cell held 50
    const relevel = resegment([top(2, 2 * SUB)], H, ground(2), 3, W, W, 4)
    expect(relevel.runs[0]!.depth).toBe(SUB + 4 * UNIT)
  })

  it('keeps volume exact through any single wall or air write, plus the units placed', () => {
    let seed = 3
    const rand = (k: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % k }
    for (let trial = 0; trial < 500; trial++) {
      const kinds: number[] = []
      for (let y = 0; y < H; y++) kinds.push(y < 2 || rand(4) === 0 ? L : A)
      const before = runsOf(H, (y) => kinds[y]!)
      const old: Seg[] = before.map((r, k) => ({ ...r, id: k === before.length - 1 ? TOP : k, depth: rand(Math.max(1, (r.ceil - r.floor) * SUB)) }))
      const y = 2 + rand(H - 3), ok = kinds[y]!
      // the cell held air or a wall (never a water voxel here): nothing is removed, only placed
      const nk = ok === L ? (rand(2) === 0 ? A : W) : rand(3) === 0 ? W : L
      const units = nk === W ? 1 + rand(8) : 0
      const after = kinds.slice()
      after[y] = nk === W ? A : nk
      const r = resegment(old, H, (yy) => after[yy]!, y, ok, nk, units)
      expect(sum(r.runs)).toBe(sum(old) + units * UNIT)
      for (let k = 0; k < r.runs.length - 1; k++) expect(r.runs[k]!.ceil).toBeLessThanOrEqual(r.runs[k + 1]!.floor)
    }
  })
})
