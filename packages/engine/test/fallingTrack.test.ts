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
