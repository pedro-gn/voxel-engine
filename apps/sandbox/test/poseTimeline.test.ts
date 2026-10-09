import { describe, expect, it } from 'vitest'
import { DELAY_MS, HISTORY, PoseTimeline } from '../src/poseTimeline.ts'

type Pose = { x: number; y: number; z: number; facing: number }

describe('sim-time pose playback', () => {
  it('moves at constant speed when messages arrive with jitter', () => {
    const t = new PoseTimeline(), out = new Map<number, Pose>()
    const pose = (tick: number) => Int32Array.from([1, tick * 64, 1024, 128, 0, 2, 0, 0, 0])
    const arrivals = [0, 61, 95, 160, 199, 262, 300]   // ±12 ms jitter around 50 ms
    // Messages arrive between frames, as in the page: each frame samples what has arrived by then.
    const xs: number[] = []
    let next = 0
    for (let now = 100; now <= 300; now += 10) {
      while (next < arrivals.length && arrivals[next]! <= now) { t.push(next, pose(next), arrivals[next]!); next++ }
      t.sample(now, out); xs.push(out.get(1)!.x)
    }
    const steps = xs.slice(1).map((x, i) => x - xs[i]!)
    for (const s of steps) expect(s).toBeCloseTo(steps[0]!, 1)
    expect(steps[0]).toBeGreaterThan(0)
  })
  it('does not skip a tick when two arrive between frames', () => {
    const t = new PoseTimeline(), out = new Map<number, Pose>()
    t.push(0, Int32Array.from([1, 0, 0, 0, 0, 2, 0, 0, 0]), 0)
    t.push(1, Int32Array.from([1, 256, 0, 0, 0, 2, 0, 0, 0]), 100)
    t.push(2, Int32Array.from([1, 256, 0, 256, 0, 2, 0, 0, 0]), 100)
    t.sample(100 + DELAY_MS + 25 - 50, out)   // midway between ticks 1 and 2 on sim time
    expect(out.get(1)!.x).toBeCloseTo(1, 1)
    expect(out.get(1)!.z).toBeCloseTo(.5, 1)
  })
  it('holds the newest pose when the sim is late instead of extrapolating', () => {
    const t = new PoseTimeline(), out = new Map<number, Pose>()
    t.push(0, Int32Array.from([1, 0, 0, 0, 0, 2, 0, 0, 0]), 0); t.push(1, Int32Array.from([1, 256, 0, 0, 0, 2, 0, 0, 0]), 50)
    t.sample(5000, out); expect(out.get(1)!.x).toBe(1)
  })
  it('resumes from the held pose after a stall instead of stepping tick by tick', () => {
    const t = new PoseTimeline(), out = new Map<number, Pose>()
    const pose = (tick: number) => Int32Array.from([1, tick * 256, 0, 0, 0, 2, 0, 0, 0])
    t.push(0, pose(0), 0); t.push(1, pose(1), 50)
    t.sample(1000, out); expect(out.get(1)!.x).toBe(1)
    // The sim comes back 1 s late and stays that late.
    t.push(2, pose(2), 1100); t.sample(1100, out); expect(out.get(1)!.x).toBeCloseTo(1, 1)
    t.sample(1125, out); expect(out.get(1)!.x).toBeCloseTo(1.5, 1)
    t.push(3, pose(3), 1150); t.sample(1150, out); expect(out.get(1)!.x).toBeCloseTo(2, 1)
    t.sample(1175, out); expect(out.get(1)!.x).toBeCloseTo(2.5, 1)
  })
  it('follows an earlier clock at once and a later one by at most 1 ms per message', () => {
    const t = new PoseTimeline(), pose = Int32Array.from([1, 0, 0, 0, 0, 2, 0, 0, 0])
    t.push(0, pose, 20); expect(t.offset).toBe(20)
    t.push(1, pose, 80); expect(t.offset).toBe(21)
    t.push(2, pose, 105); expect(t.offset).toBe(5)
  })
  it('keeps the last HISTORY ticks, takes facing from the later tick and drops ids gone from the newest', () => {
    const t = new PoseTimeline(), out = new Map<number, Pose>()
    for (let tick = 0; tick < HISTORY + 2; tick++) t.push(tick, Int32Array.from([1, tick * 256, 0, 0, tick % 4, 2, 0, 0, 0, ...tick < HISTORY + 1 ? [2, 0, 0, 0, 0, 0, 0, 0, 0] : []]), tick * 50)
    t.sample(0, out)   // before every kept tick: the oldest kept pose
    expect(out.get(1)!.x).toBe(2)
    expect(out.has(2)).toBe(false)
    t.sample((HISTORY + 1) * 50 + DELAY_MS - 40, out)   // 0.2 of the way from tick HISTORY to HISTORY + 1
    expect(out.get(1)!.x).toBeCloseTo(HISTORY + .2, 5)
    expect(out.get(1)!.facing).toBe((HISTORY + 1) % 4)
  })
  it('shows a unit that appears in the newest tick at its first pose', () => {
    const t = new PoseTimeline(), out = new Map<number, Pose>()
    t.push(0, Int32Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0]), 0)
    t.push(1, Int32Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 7, 512, 256, 768, 1, 0, 0, 0, 0]), 50)
    t.sample(50, out)
    expect(out.get(7)).toEqual({ x: 2, y: 1, z: 3, facing: 1 })
  })
  it('starts over when the tick numbers go back', () => {
    const t = new PoseTimeline(), out = new Map<number, Pose>()
    t.push(10, Int32Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0]), 0)
    t.push(11, Int32Array.from([1, 256, 0, 0, 0, 0, 0, 0, 0]), 50)
    t.push(0, Int32Array.from([1, 1280, 0, 0, 0, 0, 0, 0, 0]), 100)
    expect(t.offset).toBe(100)
    t.sample(100, out); expect(out.get(1)!.x).toBe(5)
  })
})
