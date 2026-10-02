import { describe, expect, it } from 'vitest'
import { Scheduler } from '../src/sim/scheduler.ts'

describe('Scheduler', () => {
  it('drains FIFO within a due tick, earlier ticks first', () => {
    const s = new Scheduler()
    s.schedule(10, 6)
    s.schedule(20, 5)
    s.schedule(30, 5)
    expect(s.drain(4, 100)).toEqual([])
    expect(s.drain(6, 100)).toEqual([20, 30, 10])
    expect(s.size).toBe(0)
  })
  it('dedupes per position, keeping the earliest due tick', () => {
    const s = new Scheduler()
    s.schedule(1, 10)
    s.schedule(1, 12) // later: ignored
    s.schedule(1, 8)  // earlier: moves it
    expect(s.size).toBe(1)
    expect(s.drain(8, 100)).toEqual([1])
    expect(s.drain(20, 100)).toEqual([]) // the stale tick-10 entry is skipped
  })
  it('spills past the limit into the next drain, in order', () => {
    const s = new Scheduler()
    for (let p = 0; p < 5; p++) s.schedule(p, 3)
    s.schedule(99, 4)
    expect(s.drain(3, 2)).toEqual([0, 1])
    expect(s.drain(4, 10)).toEqual([2, 3, 4, 99])
  })
  it('allows a drained position to be scheduled again', () => {
    const s = new Scheduler()
    s.schedule(5, 1)
    expect(s.drain(1, 10)).toEqual([5])
    s.schedule(5, 2)
    expect(s.drain(2, 10)).toEqual([5])
  })
})
