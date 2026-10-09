import { describe, expect, it } from 'vitest'
import { AGE_CAP, AGE_TICKS, effectivePriority } from '../src/sim/workers/frontier.ts'

describe('task frontier', () => {
  it('ages by one per 5 s without progress, capped at +64', () => {
    expect(AGE_TICKS).toBe(100); expect(AGE_CAP).toBe(64)
    expect(effectivePriority(64, 0, 99)).toBe(64)
    expect(effectivePriority(64, 0, 100)).toBe(65)
    expect(effectivePriority(64, 0, 100 * 1000)).toBe(128)
    expect(effectivePriority(200, 50, 50)).toBe(200)
  })
})
