import { describe, expect, it } from 'vitest'
import { AGE_CAP, AGE_TICKS, effectivePriority, parkChoice, shares } from '../src/sim/workers/frontier.ts'

const sum = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0)

describe('task frontier', () => {
  it('ages by one per 5 s without progress, capped at +64', () => {
    expect(AGE_TICKS).toBe(100); expect(AGE_CAP).toBe(64)
    expect(effectivePriority(64, 0, 99)).toBe(64)
    expect(effectivePriority(64, 0, 100)).toBe(65)
    expect(effectivePriority(64, 0, 100 * 1000)).toBe(128)
    expect(effectivePriority(200, 50, 50)).toBe(200)
  })
  it('splits 256 slots by weight with a floor of 8 and never beyond what an order can expose', () => {
    const s = shares([{ id: 1, weight: 128, open: 1000 }, { id: 2, weight: 128, open: 5 }, { id: 3, weight: 64, open: 1000 }], 256)
    expect(s.get(2)).toBe(5)
    expect(s.get(1)! + s.get(3)!).toBe(251)
    expect(s.get(1)! > s.get(3)!).toBe(true)
    expect(s.get(3)!).toBeGreaterThanOrEqual(8)
  })
  it('gives leftovers by weight, then to the lower id', () => {
    const even = shares([{ id: 2, weight: 1, open: 100 }, { id: 1, weight: 1, open: 100 }, { id: 3, weight: 1, open: 100 }], 32, 0)
    expect([even.get(1), even.get(2), even.get(3)]).toEqual([11, 11, 10])
    const s = shares([{ id: 5, weight: 10, open: 100 }, { id: 4, weight: 20, open: 100 }], 10, 0)
    expect(s.get(4)! + s.get(5)!).toBe(10); expect(s.get(4)).toBe(7)
  })
  it('never hands out more than the slots, even when the floors alone exceed them', () => {
    const orders = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, weight: i < 20 ? 64 : 200, open: 1000 }))
    const s = shares(orders, 256)
    expect(sum(s)).toBe(256)
    for (const o of orders) expect(s.get(o.id)).toBeLessThanOrEqual(8)
    // The heavier orders keep their floor first.
    for (let id = 21; id <= 40; id++) expect(s.get(id)).toBe(8)
  })
  it('leaves slots unused when the orders cannot expose them, and gives nothing to an empty order', () => {
    const s = shares([{ id: 1, weight: 128, open: 3 }, { id: 2, weight: 255, open: 0 }, { id: 3, weight: 0, open: 20 }], 256)
    expect([s.get(1), s.get(2), s.get(3)]).toEqual([3, 0, 20])
  })
  it('splits evenly among zero weights', () => {
    const s = shares([{ id: 1, weight: 0, open: 100 }, { id: 2, weight: 0, open: 100 }], 40)
    expect([s.get(1), s.get(2)]).toEqual([20, 20])
  })
  it('parks the lowest-priority unclaimed parkable task, then the oldest, then the lowest cell', () => {
    const t = (i: number, priority: number, added: number, claimed = false, parkable = true) => ({ i, priority, added, claimed, parkable })
    expect(parkChoice([t(0, 200, 1), t(1, 64, 5), t(2, 128, 0)])).toBe(1)
    expect(parkChoice([t(0, 64, 5), t(1, 64, 3), t(2, 64, 3)])).toBe(1)
    expect(parkChoice([t(9, 64, 3), t(4, 64, 3)])).toBe(1)
    expect(parkChoice([t(0, 1, 0, true), t(1, 2, 0, false, false), t(2, 255, 9)])).toBe(2)
    expect(parkChoice([t(0, 1, 0, true), t(1, 2, 0, false, false)])).toBe(-1)
  })
})
