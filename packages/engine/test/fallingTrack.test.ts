import { describe, expect, it } from 'vitest'
import { FallingTrack, MARGIN, RUSH_CAP, RUSH_MS, cubeLight } from '../src/render/fallingTrack.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, waterSim } from './waterHelpers.ts'

const body = (id: number, y256: number, vy256 = 24) => ({ id, voxel: 8, x: 3, z: 4, y256, vy256 })
/** With messages on time, tick t is drawn from (t + 1) × 50 ms + LAG on. */
const LAG = MARGIN * 50

const V = 400, TOP = 500000, FRAME = 1000 / 180
/** Blocks per second of a body falling V/256 block per tick. */
const trueSpeed = (tickMs: number) => ((V / 256) * 1000) / tickMs
/** The (fractional) tick whose height a cube of `fall` is drawn at. */
const drawnTick = (y: number) => 100 + (TOP - y * 256) / V
/** Drives a track at 180 fps with one body falling V per tick; tick 100 + n arrives at `arrival(n)` (non-decreasing). */
function fall(tickMs: number, arrival: (n: number) => number, ticks: number): { now: number; y: number }[] {
  const t = new FallingTrack(tickMs), arr = Array.from({ length: ticks }, (_, n) => arrival(n)), out: { now: number; y: number }[] = []
  let next = 0
  for (let now = 1000; now < 1000 + (ticks - 1) * tickMs; now += FRAME) {
    while (next < ticks && arr[next]! <= now) { t.update(100 + next, [body(1, TOP - V * next, V)], [], now); next++ }
    const c = t.frame(now, () => -1)
    if (c.length > 0) out.push({ now, y: c[0]!.y })
  }
  return out
}
/** Downward speed (blocks/s) between consecutive frames. */
const speeds = (f: { now: number; y: number }[]) => f.slice(1).map((g, i) => ({ now: g.now, v: (f[i]!.y - g.y) / ((g.now - f[i]!.now) / 1000) }))

describe('FallingTrack', () => {
  it('starts a new body at its old cell and interpolates over one tick', () => {
    const t = new FallingTrack(50)
    t.update(20, [body(1, 2560 - 24)], [], 1000)
    expect(t.frame(1000 + LAG, () => -1)).toEqual([{ voxel: 8, x: 3, y: 10, z: 4 }])
    expect(t.frame(1025 + LAG, () => -1)[0]!.y).toBeCloseTo((2560 - 12) / 256, 6)
    t.update(21, [body(1, 2560 - 72, 48)], [], 1050)
    expect(t.frame(1050 + LAG, () => -1)[0]!.y).toBeCloseTo((2560 - 24) / 256, 6)
  })
  it('keeps a landed body until the mesh of its chunk at the landing version is applied', () => {
    const t = new FallingTrack(50)
    t.update(0, [body(1, 300)], [], 0)
    t.update(1, [], [{ id: 1, x: 3, y: 1, z: 4, chunk: 7, version: 12 }], 50)
    let applied = 10
    expect(t.frame(100 + LAG, () => applied)).toEqual([{ voxel: 8, x: 3, y: 1, z: 4 }])
    t.update(2, [], [], 100) // later ticks hold it still
    expect(t.frame(120 + LAG, () => applied)[0]!.y).toBe(1)
    applied = 12
    expect(t.frame(140 + LAG, () => applied)).toEqual([])
    expect(t.size).toBe(0)
  })
  it('finishes the glide within RUSH_MS once the mesh is in, never faster than RUSH_CAP x terminal speed', () => {
    const t = new FallingTrack(50)
    t.update(0, [body(1, 6 * 256 + 100, 400)], [], 0)
    t.update(1, [body(1, 5 * 256 + 180, 432)], [], 50)
    t.update(2, [], [{ id: 1, x: 3, y: 4, z: 4, chunk: 7, version: 12 }], 100) // lands 436/256 blocks below the shown cube
    const FRAME = 1000 / 180, applied = () => 12 // the remesh is already in
    const start = 100 + LAG
    let last = t.frame(start, applied)[0]!.y, now = start
    expect(last).toBeCloseTo((5 * 256 + 180) / 256, 6)
    for (;;) {
      now += FRAME
      const cubes = t.frame(now, applied)
      if (cubes.length === 0) break
      const y = cubes[0]!.y
      expect(y).toBeGreaterThanOrEqual(4)
      expect(last - y).toBeGreaterThanOrEqual(0)
      expect(last - y).toBeLessThanOrEqual((RUSH_CAP * 2 * FRAME) / 50 + 1e-9)
      last = y
      expect(now - start).toBeLessThanOrEqual(RUSH_MS + FRAME)
    }
    expect(now - start).toBeLessThanOrEqual(RUSH_MS + 2 * FRAME) // hidden the frame after it rests in its cell
    expect(t.size).toBe(0)
  })
  it('holds a landed cube at its landing cell until the mesh at the landing version is applied', () => {
    const t = new FallingTrack(50)
    t.update(0, [body(1, 300)], [], 0)
    t.update(1, [], [{ id: 1, x: 3, y: 1, z: 4, chunk: 7, version: 12 }], 50)
    expect(t.frame(75 + LAG, () => 12)).toHaveLength(1) // mid-glide: still drawn although the mesh is applied
    expect(t.frame(100 + LAG, () => 11)).toEqual([{ voxel: 8, x: 3, y: 1, z: 4 }]) // at the cell, waiting for the mesh
    t.update(2, [], [], 100)
    expect(t.frame(130 + LAG, () => 11)).toEqual([{ voxel: 8, x: 3, y: 1, z: 4 }])
    expect(t.frame(135 + LAG, () => 12)).toEqual([])
  })
  for (const tickMs of [50, 1000 / 30]) it(`moves a falling cube at its true speed although tick messages arrive with jitter (tick ${tickMs.toFixed(1)} ms)`, () => {
    // Each message reaches the main thread 0-25 ms late and the frame loop (180 fps) only sees it at the next frame.
    let seed = 12345
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32)
    const frames = fall(tickMs, (n) => 1000 + n * tickMs + rnd() * 25, 90)
    const worst = Math.max(...speeds(frames).filter((f) => f.now > 1000 + 300).map((f) => Math.abs(f.v - trueSpeed(tickMs)) / trueSpeed(tickMs)))
    expect(worst).toBeLessThanOrEqual(0.15)
  })
  it('holds a cube while a tick message is late, then goes on from there without catching up in a jump', () => {
    const frames = fall(50, (n) => 1000 + (n === 20 ? 21 : n) * 50 + 3, 40) // a late sim timer: ticks 20 and 21 arrive together
    const v = speeds(frames)
    for (const f of v) expect(f.v).toBeGreaterThanOrEqual(0)
    for (const f of v) expect(f.v).toBeLessThanOrEqual(1.15 * trueSpeed(50))
    expect(v.some((f) => f.v === 0)).toBe(true) // it did wait for the late tick rather than extrapolate
  })
  it('forgets a hitch within about a second: the drawing lag returns to normal', () => {
    // A 200 ms main-thread stall delivers ticks 20-23 together at its end; every other message is 3 ms late.
    const stallEnd = 1000 + 20 * 50 + 200
    const frames = fall(50, (n) => Math.max(1000 + n * 50 + 3, n >= 20 && n <= 23 ? stallEnd : 0), 80)
    for (const f of speeds(frames)) expect(f.v).toBeGreaterThanOrEqual(0)
    for (const f of speeds(frames)) expect(f.v).toBeLessThanOrEqual(1.55 * trueSpeed(50)) // FAST_SLEW, no jump
    const excess = (f: { now: number; y: number }) => (f.now - 1003) / 50 + 100 - 1 - MARGIN - drawnTick(f.y)
    expect(excess(frames.find((f) => f.now > stallEnd)!)).toBeGreaterThan(2) // it did fall behind
    for (const f of frames.filter((f) => f.now > stallEnd + 1500)) expect(Math.abs(excess(f))).toBeLessThan(FRAME / 50) // arrivals are seen up to a frame late
  })
  it('restarts the estimate when the latency jumps by more than RESYNC ticks, without moving a drawn cube back up', () => {
    // The sim pauses for 400 ms after tick 20: every later message is 400 ms later than before, for good.
    const frames = fall(50, (n) => 1000 + n * 50 + 3 + (n >= 20 ? 400 : 0), 80)
    for (const f of speeds(frames)) expect(f.v).toBeGreaterThanOrEqual(0)
    for (const f of speeds(frames)) expect(f.v).toBeLessThanOrEqual(1.55 * trueSpeed(50))
    const excess = (f: { now: number; y: number }) => (f.now - 1403) / 50 + 100 - 1 - MARGIN - drawnTick(f.y)
    for (const f of frames.filter((f) => f.now > 1000 + 20 * 50 + 400 + 1500)) expect(Math.abs(excess(f))).toBeLessThan(FRAME / 50) // arrivals are seen up to a frame late
  })
  it('restarts the estimate when messages turn much earlier than it, and catches up without a jump', () => {
    // The first 20 messages are 300 ms late (a busy start), then they arrive on time.
    const frames = fall(50, (n) => Math.max(1000 + n * 50 + 3 + (n < 20 ? 300 : 0), n < 20 ? 0 : 1000 + 19 * 50 + 303), 80)
    for (const f of speeds(frames)) expect(f.v).toBeGreaterThanOrEqual(0)
    for (const f of speeds(frames)) expect(f.v).toBeLessThanOrEqual(1.55 * trueSpeed(50))
    const excess = (f: { now: number; y: number }) => (f.now - 1003) / 50 + 100 - 1 - MARGIN - drawnTick(f.y)
    for (const f of frames.filter((f) => f.now > 1000 + 20 * 50 + 300 + 1500)) expect(Math.abs(excess(f))).toBeLessThan(FRAME / 50) // arrivals are seen up to a frame late
  })
  it('keeps a bounded height history while no frame runs (a background tab), and draws the right height after', () => {
    const t = new FallingTrack(50)
    const heights = () => (t as unknown as { bodies: Map<number, { samples: unknown[] }> }).bodies.get(1)!.samples.length
    t.update(100, [body(1, TOP, V)], [], 1000 + 3)
    t.frame(1010, () => -1)
    const N = 20 * 60 * 10 // ten minutes of tick messages, not one frame
    for (let n = 1; n <= N; n++) t.update(100 + n, [body(1, TOP - V * n, V)], [], 1000 + n * 50 + 3)
    expect(heights()).toBeLessThanOrEqual(8)
    const now = 1000 + N * 50 + 3 + 1 // the first frame back
    const c = t.frame(now, () => -1)
    expect(drawnTick(c[0]!.y)).toBeCloseTo((now - 1003) / 50 + 100 - 1 - MARGIN, 6)
    expect(heights()).toBeLessThanOrEqual(3)
  })
  it('forgets a body that disappears without landing', () => {
    const t = new FallingTrack(50)
    t.update(0, [body(1, 300)], [], 0)
    t.update(1, [], [], 50)
    expect(t.size).toBe(0)
  })
  it('keeps a landed cube lit while it waits for its chunk mesh (the landed block makes its own cell dark)', () => {
    // A sand pillar on planks in open sky, as in ?scene=flood: drop it and draw the tick it lands, before the remesh.
    const sim = waterSim((x, y, z) => (y < 5 ? B.stone : x === 10 && z === 10 && y >= 20 && y <= 24 ? (y === 20 ? B.dirt : B.sand) : AIR))
    sim.submit(0, 0, { type: 'setBlock', pos: [10, 20, 10], voxel: AIR })
    const t = new FallingTrack(50)
    for (let tick = 0; tick < 40; tick++) {
      const r = sim.step()
      t.update(tick, r.falling, r.landed, tick * 50)
      if (r.landed.length === 0) continue
      const light = (x: number, y: number, z: number) => sim.store.getLight(x, y, z)
      for (const now of [tick * 50, tick * 50 + 25, tick * 50 + 50]) {
        const cubes = t.frame(now, () => -1)
        expect(cubes.length).toBeGreaterThan(0)
        for (const c of cubes) expect(cubeLight(light, c.x, c.y, c.z) & 15, `cube at y=${c.y}, t=${now}`).toBe(15)
      }
      return
    }
    throw new Error('the pillar never landed')
  })
  it('lights a cube in an open cell from that cell, and one inside a block from its brightest face neighbour', () => {
    const cells = new Map([['3,10,4', 0x2c], ['3,11,4', 0], ['3,12,4', 0x07], ['4,11,4', 0x50], ['3,11,5', 0x0e]])
    const light = (x: number, y: number, z: number) => cells.get(`${x},${y},${z}`) ?? 0
    expect(cubeLight(light, 3, 9.6, 4)).toBe(0x2c)
    expect(cubeLight(light, 3, 11.2, 4)).toBe(0x5e) // sky 14 from z+1, block 5 from x+1
  })
})
