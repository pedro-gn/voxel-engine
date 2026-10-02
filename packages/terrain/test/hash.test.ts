import { describe, expect, it } from 'vitest'
import { hash2, hash3, unit } from '../src/noise/hash.ts'

describe('hash2 / hash3', () => {
  it('is deterministic and sensitive to every input', () => {
    expect(hash2(1, 3, 5)).toBe(hash2(1, 3, 5))
    expect(hash2(1, 3, 5)).not.toBe(hash2(2, 3, 5))
    expect(hash2(1, 3, 5)).not.toBe(hash2(1, 5, 3))
    expect(hash3(1, 3, 5, 7)).not.toBe(hash3(1, 3, 7, 5))
  })
  it('matches golden values, so output is identical on every JS engine', () => {
    expect([hash2(0, 0, 0), hash2(1234, -7, 99), hash3(1234, 5, -6, 7)]).toEqual(GOLDEN)
  })
  it('returns unsigned 32-bit integers that map uniformly into [0, 1)', () => {
    const buckets = new Array<number>(10).fill(0)
    for (let i = 0; i < 20000; i++) {
      const h = hash2(7, i, i * 3)
      expect(Number.isInteger(h) && h >= 0 && h < 2 ** 32).toBe(true)
      buckets[Math.floor(unit(h) * 10)]!++
    }
    for (const b of buckets) expect(b).toBeGreaterThan(1800)
    for (const b of buckets) expect(b).toBeLessThan(2200)
  })
})

const GOLDEN = [1680814304, 3461463847, 3409246125]
