import { describe, expect, it } from 'vitest'
import { FallingTrack, cubeLight } from '../src/render/fallingTrack.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, fluidSim } from './fluidHelpers.ts'

const body = (id: number, y256: number, vy256 = 24) => ({ id, voxel: 8, x: 3, z: 4, y256, vy256 })

describe('FallingTrack', () => {
  it('starts a new body at its old cell and interpolates over one tick', () => {
    const t = new FallingTrack()
    t.update([body(1, 2560 - 24)], [], 1000)
    expect(t.frame(1000, 50, () => -1)).toEqual([{ voxel: 8, x: 3, y: 10, z: 4 }])
    expect(t.frame(1025, 50, () => -1)[0]!.y).toBeCloseTo((2560 - 12) / 256, 6)
    t.update([body(1, 2560 - 72, 48)], [], 1050)
    expect(t.frame(1050, 50, () => -1)[0]!.y).toBeCloseTo((2560 - 24) / 256, 6)
  })
  it('keeps a landed body until the mesh of its chunk at the landing version is applied', () => {
    const t = new FallingTrack()
    t.update([body(1, 300)], [], 0)
    t.update([], [{ id: 1, x: 3, y: 1, z: 4, chunk: 7, version: 12 }], 50)
    let applied = 10
    expect(t.frame(100, 50, () => applied)).toEqual([{ voxel: 8, x: 3, y: 1, z: 4 }])
    t.update([], [], 100) // later ticks hold it still
    expect(t.frame(120, 50, () => applied)[0]!.y).toBe(1)
    applied = 12
    expect(t.frame(140, 50, () => applied)).toEqual([])
    expect(t.size).toBe(0)
  })
  it('glides a landed cube down to its landing cell before handing it to the chunk mesh, even when the mesh is already applied', () => {
    const t = new FallingTrack()
    t.update([body(1, 6 * 256 + 100, 400)], [], 0)
    t.update([body(1, 5 * 256 + 180, 432)], [], 50)
    t.update([], [{ id: 1, x: 3, y: 4, z: 4, chunk: 7, version: 12 }], 100) // lands 436/256 blocks below the shown cube
    const FRAME = 1000 / 180, applied = () => 12 // the remesh is already in: only the glide holds the cube
    let last = t.frame(100, 50, applied)[0]!.y, now = 100, held = 0, ticked = false
    expect(last).toBeCloseTo((5 * 256 + 180) / 256, 6)
    for (;;) {
      now += FRAME
      if (now > 140 && !ticked) { t.update([], [], now); ticked = true } // the next tick may arrive mid-glide: no jump either
      const cubes = t.frame(now, 50, applied)
      if (cubes.length === 0) break
      const y = cubes[0]!.y
      expect(last - y).toBeGreaterThanOrEqual(0)
      expect(last - y).toBeLessThanOrEqual(((436 / 256) * FRAME) / 50 + 1e-9) // never more than one frame of the last segment's motion
      last = y
      if (++held > 100) throw new Error('never handed over')
    }
    expect(last).toBeCloseTo(4, 9) // hidden only once it has reached its landing cell
    expect(t.size).toBe(0)
  })
  it('holds a landed cube at its landing cell until the mesh at the landing version is applied', () => {
    const t = new FallingTrack()
    t.update([body(1, 300)], [], 0)
    t.update([], [{ id: 1, x: 3, y: 1, z: 4, chunk: 7, version: 12 }], 50)
    expect(t.frame(75, 50, () => 12)).toHaveLength(1) // mid-glide: still drawn although the mesh is applied
    expect(t.frame(100, 50, () => 11)).toEqual([{ voxel: 8, x: 3, y: 1, z: 4 }]) // at the cell, waiting for the mesh
    t.update([], [], 100)
    expect(t.frame(130, 50, () => 11)).toEqual([{ voxel: 8, x: 3, y: 1, z: 4 }])
    expect(t.frame(135, 50, () => 12)).toEqual([])
  })
  it('forgets a body that disappears without landing', () => {
    const t = new FallingTrack()
    t.update([body(1, 300)], [], 0)
    t.update([], [], 50)
    expect(t.size).toBe(0)
  })
  it('keeps a landed cube lit while it waits for its chunk mesh (the landed block makes its own cell dark)', () => {
    // A sand pillar on planks in open sky, as in ?scene=flood: drop it and draw the tick it lands, before the remesh.
    const sim = fluidSim((x, y, z) => (y < 5 ? B.stone : x === 10 && z === 10 && y >= 20 && y <= 24 ? (y === 20 ? B.dirt : B.sand) : AIR))
    sim.submit(0, 0, { type: 'setBlock', pos: [10, 20, 10], voxel: AIR })
    const t = new FallingTrack()
    for (let tick = 0; tick < 40; tick++) {
      const r = sim.step()
      t.update(r.falling, r.landed, tick * 50)
      if (r.landed.length === 0) continue
      const light = (x: number, y: number, z: number) => sim.store.getLight(x, y, z)
      for (const now of [tick * 50, tick * 50 + 25, tick * 50 + 50]) {
        const cubes = t.frame(now, 50, () => -1)
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
