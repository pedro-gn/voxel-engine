import { describe, expect, it } from 'vitest'
import { SimClock, stepAlpha } from '../src/render/simClock.ts'

const FRAME = 1000 / 60

describe('SimClock', () => {
  it('shows tick t at t x tickMs plus the arrival latency, snapping to it while nothing is drawn', () => {
    const c = new SimClock(50)
    c.arrive(10, 1000) // latency 500
    expect(c.advance(1000)).toBe(10)
    expect(c.advance(1025)).toBeCloseTo(10.5, 9)
    c.arrive(11, 1080) // 30 ms late: latency 530, and the clock snaps to it (nothing drawn)
    expect(c.advance(1080)).toBeCloseTo(11, 9)
    expect(c.newest).toBe(11)
  })

  it('aims for the slowest arrival of the last 500 ms', () => {
    const c = new SimClock(50)
    c.arrive(0, 1000)
    c.arrive(1, 1070) // 20 ms late
    c.arrive(2, 1100) // on time again: the 20 ms are kept
    expect(c.advance(1100)).toBeCloseTo(1.6, 9)
    for (let t = 3; t <= 14; t++) c.arrive(t, 1000 + t * 50)
    expect(c.advance(1700)).toBeCloseTo(14, 9) // tick 1's lateness left the window
  })

  it('advancing again at the same time changes nothing', () => {
    const c = new SimClock(50)
    const who = {}
    c.arrive(0, 0)
    c.hold(who, 1)
    c.arrive(1, 80)
    const a = c.advance(100)
    expect(c.advance(100)).toBe(a)
    expect(c.due).toBe(a)
  })

  it('holds at a holder\'s limit while the next message is late, then goes on from there without a jump', () => {
    const c = new SimClock(50)
    const who = {}
    c.arrive(0, 0)
    c.hold(who, 1)
    let now = 0, last = c.advance(0)
    // Tick 1 is 100 ms late: the clock stops at 1 and waits.
    for (; now + FRAME < 150; now += FRAME) { last = c.advance(now + FRAME); expect(last).toBeLessThanOrEqual(1) }
    expect(last).toBe(1)
    c.arrive(1, 150)
    c.hold(who, 2)
    const next = c.advance(now + 2 * FRAME)
    expect(next - last).toBeGreaterThan(0)
    expect(next - last).toBeLessThanOrEqual((1.1 * 2 * FRAME) / 50) // at most real speed plus the slew
  })

  it('holds at the lowest limit of its holders', () => {
    const c = new SimClock(50)
    const a = {}, b = {}
    c.arrive(0, 0)
    c.hold(a, 5)
    c.hold(b, 3)
    expect(c.advance(1000)).toBe(3)
    c.hold(b, null)
    expect(c.advance(1100)).toBe(5)
  })

  it('slews toward a lower latency at a limited rate while something is drawn', () => {
    const c = new SimClock(50)
    const who = {}
    c.hold(who, 1e9)
    c.arrive(0, 40) // latency 40
    c.advance(40)
    // From now on every tick is on time: latency 0 once tick 0 leaves the window.
    let prev = c.advance(40), now = 40
    for (let t = 1; t <= 40; t++) {
      c.arrive(t, t * 50)
      for (; now + FRAME <= t * 50; now += FRAME) {
        const d = c.advance(now + FRAME)
        expect(d - prev).toBeLessThanOrEqual((1.1 * FRAME) / 50 + 1e-9) // never more than 10% fast
        expect(d - prev).toBeGreaterThan(0)
        prev = d
      }
    }
    expect(c.advance(2000)).toBeCloseTo(40, 6) // caught up
  })

  it('restarts the estimate after a long stall, but never runs back while something is drawn', () => {
    const c = new SimClock(50)
    const who = {}
    c.arrive(0, 0)
    expect(c.advance(100)).toBe(2)
    c.hold(who, 1e9)
    c.arrive(1, 1000) // 950 ms late: beyond RESYNC, the estimate restarts at 950 ms
    expect(c.advance(1000)).toBeGreaterThan(2) // a reset offset would show tick 1
    c.hold(who, null)
    c.arrive(2, 1050)
    expect(c.advance(1050)).toBeCloseTo(2, 9) // nothing drawn: snaps to the new estimate
  })
})

describe('stepAlpha', () => {
  it('is the fraction of the step after tick `tick` the clock has reached, held to 0..1', () => {
    expect(stepAlpha(9.5, 10)).toBe(0)
    expect(stepAlpha(10.25, 10)).toBe(0.25)
    expect(stepAlpha(12, 10)).toBe(1)
  })
})
