import { describe, expect, it } from 'vitest'
import { FallingTrack, MARGIN, cubeLight } from '../src/render/fallingTrack.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, fluidSim } from './fluidHelpers.ts'

const body = (id: number, y256: number, vy256 = 24) => ({ id, voxel: 8, x: 3, z: 4, y256, vy256 })
/** With messages on time, tick t is drawn from (t + 1) × 50 ms + LAG on. */
const LAG = MARGIN * 50

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
  it('glides a landed cube down to its landing cell before handing it to the chunk mesh, even when the mesh is already applied', () => {
    const t = new FallingTrack(50)
    t.update(0, [body(1, 6 * 256 + 100, 400)], [], 0)
    t.update(1, [body(1, 5 * 256 + 180, 432)], [], 50)
    t.update(2, [], [{ id: 1, x: 3, y: 4, z: 4, chunk: 7, version: 12 }], 100) // lands 436/256 blocks below the shown cube
    const FRAME = 1000 / 180, applied = () => 12 // the remesh is already in: only the glide holds the cube
    let last = t.frame(100 + LAG, applied)[0]!.y, now = 100 + LAG, held = 0, ticked = false
    expect(last).toBeCloseTo((5 * 256 + 180) / 256, 6)
    for (;;) {
      now += FRAME
      if (now > 140 && !ticked) { t.update(3, [], [], now); ticked = true } // the next tick may arrive early, mid-glide: no jump either
      const cubes = t.frame(now, applied)
      if (cubes.length === 0) break
      const y = cubes[0]!.y
      expect(last - y).toBeGreaterThanOrEqual(0)
      expect(last - y).toBeLessThanOrEqual((1.1 * (436 / 256) * FRAME) / 50) // one frame of the last segment's motion (+ clock slew)
      last = y
      if (++held > 100) throw new Error('never handed over')
    }
    // Hidden on the first frame that would draw it at its landing cell (the applied mesh shows it there):
    // the last drawn height is within one frame's motion above the cell, never below it.
    expect(last).toBeGreaterThanOrEqual(4)
    expect(last - 4).toBeLessThanOrEqual((1.1 * (436 / 256) * FRAME) / 50)
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
  it('moves a falling cube at its true speed although tick messages arrive with jitter', () => {
    // Ticks every 50 ms of sim time; each message reaches the main thread 0-25 ms late, and the frame loop
    // (180 fps) only sees it at the next frame. The cube falls 400/256 block per tick: 31.25 blocks/s.
    const TICK = 50, FRAME = 1000 / 180, V = 400, TRUE = ((V / 256) * 1000) / TICK
    let seed = 12345
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32)
    const arrivals = Array.from({ length: 60 }, (_, n) => 1000 + n * TICK + rnd() * 25)
    const t = new FallingTrack(TICK)
    let next = 0, prevY: number | null = null, worst = 0
    for (let now = 1000; now < 1000 + 59 * TICK; now += FRAME) {
      while (next < arrivals.length && arrivals[next]! <= now) {
        t.update(100 + next, [body(1, 50000 - V * next, V)], [], now)
        next++
      }
      const c = t.frame(now, () => -1)
      if (c.length === 0) continue
      const y = c[0]!.y
      if (prevY !== null && now > 1000 + 6 * TICK) worst = Math.max(worst, Math.abs((prevY - y) / (FRAME / 1000) - TRUE) / TRUE)
      prevY = y
    }
    expect(worst).toBeLessThanOrEqual(0.15)
  })
  it('holds a cube while a tick message is late, then goes on from there without catching up in a jump', () => {
    const TICK = 50, FRAME = 1000 / 180, V = 400, TRUE = ((V / 256) * 1000) / TICK
    const arrivals = Array.from({ length: 40 }, (_, n) => 1000 + n * TICK + 3)
    arrivals[20] = arrivals[21]! // a late sim timer: ticks 20 and 21 arrive together
    const t = new FallingTrack(TICK)
    let next = 0, prevY: number | null = null, held = 0
    for (let now = 1000; now < 1000 + 39 * TICK; now += FRAME) {
      while (next < arrivals.length && arrivals[next]! <= now) {
        t.update(100 + next, [body(1, 50000 - V * next, V)], [], now)
        next++
      }
      const c = t.frame(now, () => -1)
      if (c.length === 0) continue
      const y = c[0]!.y
      if (prevY !== null) {
        const speed = (prevY - y) / (FRAME / 1000)
        expect(speed).toBeGreaterThanOrEqual(0)
        expect(speed).toBeLessThanOrEqual(1.15 * TRUE)
        if (speed === 0) held++
      }
      prevY = y
    }
    expect(held).toBeGreaterThan(0) // it did wait for the late tick rather than extrapolate
  })
  it('forgets a body that disappears without landing', () => {
    const t = new FallingTrack(50)
    t.update(0, [body(1, 300)], [], 0)
    t.update(1, [], [], 50)
    expect(t.size).toBe(0)
  })
  it('keeps a landed cube lit while it waits for its chunk mesh (the landed block makes its own cell dark)', () => {
    // A sand pillar on planks in open sky, as in ?scene=flood: drop it and draw the tick it lands, before the remesh.
    const sim = fluidSim((x, y, z) => (y < 5 ? B.stone : x === 10 && z === 10 && y >= 20 && y <= 24 ? (y === 20 ? B.dirt : B.sand) : AIR))
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
