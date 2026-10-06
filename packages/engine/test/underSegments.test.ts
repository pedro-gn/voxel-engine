import { describe, expect, it } from 'vitest'
import { SUB } from '../src/sim/water/constants.ts'
import { UnderSegments } from '../src/sim/water/under.ts'

describe('UnderSegments', () => {
  it('chains a column bottom-up and ranks its segments from the top (the top segment is rank 0)', () => {
    const u = new UnderSegments(4)
    const a = u.alloc(2, 1, 4, SUB), b = u.alloc(2, 6, 9, 0), c = u.alloc(2, 11, 12, 3)
    u.setChain(2, [a, b, c])
    expect(u.chain(2, [])).toEqual([a, b, c])
    expect([u.rankOf(a), u.rankOf(b), u.rankOf(c)]).toEqual([3, 2, 1])
    expect(u.first[1]).toBe(-1)
    expect(u.cap(a)).toBe(3 * SUB)
    expect(u.surface(a)).toBe(SUB + SUB)
  })

  it('reuses freed indices last-freed-first, so the same edits allocate the same indices', () => {
    const u = new UnderSegments(4)
    const a = u.alloc(0, 0, 2, 0), b = u.alloc(0, 3, 5, 0)
    u.setChain(0, [a, b])
    const freed: number[] = []
    u.freeColumn(0, freed)
    expect(freed).toEqual([a, b])
    expect(u.first[0]).toBe(-1)
    expect(u.count).toBe(0)
    expect(u.alloc(1, 0, 1, 0)).toBe(b)
    expect(u.alloc(1, 2, 3, 0)).toBe(a)
  })

  it('grows past its first capacity and keeps every field', () => {
    const u = new UnderSegments(1)
    const ids: number[] = []
    for (let k = 0; k < 200; k++) ids.push(u.alloc(0, 2 * k, 2 * k + 1, k))
    u.setChain(0, ids)
    expect(u.count).toBe(200)
    expect(u.depth[ids[150]!]).toBe(150)
    expect(u.rankOf(ids[0]!)).toBe(200)
  })

  it('totals depth and excess, and its hash changes with any segment', () => {
    const u = new UnderSegments(2)
    const a = u.alloc(1, 0, 2, 100)
    u.setChain(1, [a])
    u.excess[a] = 7
    expect(u.total()).toBe(107)
    const hash = () => { let h = 0; u.mixState((v) => { h = (Math.imul(h, 31) + v) | 0 }); return h }
    const h0 = hash()
    u.depth[a] = 101
    expect(hash()).not.toBe(h0)
  })
})
