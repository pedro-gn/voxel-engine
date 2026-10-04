import { describe, expect, it } from 'vitest'
import { CostMeter } from '../src/render/costMeter.ts'

describe('CostMeter', () => {
  it('reports 0 before any sample', () => {
    const m = new CostMeter(200)
    expect(m.last).toBe(0)
    expect(m.p95()).toBe(0)
    expect(m.count).toBe(0)
  })

  it('keeps the last sample and the p95 of the samples kept', () => {
    const m = new CostMeter(200)
    for (let i = 1; i <= 100; i++) m.record(i)
    expect(m.last).toBe(100)
    expect(m.count).toBe(100)
    expect(m.p95()).toBe(96) // the sample at rank floor(100 × 0.95) of 1..100
  })

  it('forgets samples older than its window', () => {
    const m = new CostMeter(10)
    for (let i = 0; i < 10; i++) m.record(1000) // a spike long ago…
    for (let i = 0; i < 10; i++) m.record(i) // …pushed out by 10 cheap samples
    expect(m.count).toBe(10)
    expect(m.p95()).toBe(9)
    expect(m.last).toBe(9)
  })
})
