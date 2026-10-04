import { describe, expect, it } from 'vitest'
import { BlockRegistry } from '../src/blocks/registry.ts'
import { GravitySystem, MAX_FALL_256 } from '../src/sim/gravity.ts'
import { SUB } from '../src/sim/water/constants.ts'
import { Layout } from '../src/world/layout.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, WATER_BLOCKS, lake, run, spring, w, waterSim } from './waterHelpers.ts'

const floor = (_x: number, y: number) => (y === 0 ? B.stone : AIR)

describe('gravity', () => {
  it('lifts an unsupported block out of the grid and lands it, accelerating to a cap', () => {
    const sim = waterSim(floor)
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 20, 5], voxel: B.sand })
    const r0 = sim.step()
    expect(sim.store.getVoxel(5, 20, 5)).toBe(AIR)
    expect(r0.falling).toEqual([{ id: 1, voxel: B.sand, x: 5, z: 5, y256: 20 * 256 - 24, vy256: 24 }])
    let landedAt = -1
    for (let t = 1; t < 60 && landedAt < 0; t++) {
      const r = sim.step()
      for (const b of r.falling) expect(b.vy256).toBeLessThanOrEqual(MAX_FALL_256)
      if (r.landed.length > 0) {
        landedAt = t
        expect(r.landed[0]).toMatchObject({ id: 1, x: 5, y: 1, z: 5, chunk: 0 })
        expect(r.landed[0]!.version % 2).toBe(0)
        expect(r.landed[0]!.version).toBe(sim.store.versions[0])
      }
    }
    expect(landedAt).toBeGreaterThan(0)
    expect(sim.store.getVoxel(5, 1, 5)).toBe(B.sand)
    expect(sim.gravity.count).toBe(0)
  })
  it('drops a whole column together and stacks it', () => {
    const sim = waterSim(floor)
    sim.submit(0, 0, { type: 'fillRegion', min: [3, 10, 3], max: [3, 12, 3], voxel: B.sand })
    const r = sim.step()
    expect(r.falling.map((b) => b.id)).toEqual([1, 2, 3])
    run(sim, 40)
    expect([1, 2, 3, 4].map((y) => sim.store.getVoxel(3, y, 3))).toEqual([B.sand, B.sand, B.sand, AIR])
  })
  it('passes a torch on the way and destroys one in its landing cell', () => {
    const sim = waterSim((x, y, z) => (y === 0 ? B.stone : x === 7 && z === 7 && (y === 1 || y === 5) ? B.torch : AIR))
    sim.submit(0, 0, { type: 'setBlock', pos: [7, 9, 7], voxel: B.sand })
    run(sim, 40)
    expect(sim.store.getVoxel(7, 5, 7)).toBe(B.torch)
    expect(sim.store.getVoxel(7, 1, 7)).toBe(B.sand)
  })
  it('lands on a spring without overwriting it', () => {
    const sim = waterSim((x, y, z) => (y === 0 ? B.stone : x === 7 && z === 7 && y === 1 ? spring() : AIR))
    sim.submit(0, 0, { type: 'setBlock', pos: [7, 9, 7], voxel: B.sand })
    run(sim, 40)
    expect(sim.store.getVoxel(7, 1, 7)).toBe(spring())
    expect(sim.store.getVoxel(7, 2, 7)).toBe(B.sand)
    expect(sim.gravity.count).toBe(0)
  })
  it('sinks through a lake to its floor; the lake keeps its water and its floor there rises', () => {
    const sim = waterSim(lake(4))
    const v0 = sim.water.total()
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 8, 5], voxel: B.sand })
    run(sim, 30)
    expect(sim.store.getVoxel(5, 1, 5)).toBe(B.sand)
    expect(sim.water.column(5, 5).floor).toBe(2)
    expect(sim.water.total()).toBe(v0)
  })
  it('pushes the water of a one-column well up when it lands in it', () => {
    const sim = waterSim((x, y, z) => (y === 0 ? B.stone : (x === 4 || x === 6 || z === 4 || z === 6) && y <= 3 ? B.stone : AIR))
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 1, 5], voxel: w(5) })
    sim.step()
    const v0 = sim.water.total()
    expect(v0).toBe((6 * SUB) / 8)
    sim.submit(0, 1, { type: 'setBlock', pos: [5, 9, 5], voxel: B.sand })
    run(sim, 30)
    expect(sim.store.getVoxel(5, 1, 5)).toBe(B.sand)
    expect(sim.water.column(5, 5)).toMatchObject({ floor: 2, depth: v0 })
    expect(sim.water.total()).toBe(v0)
  })
  it('logs a throwing physics phase, drops the job, and finishes the tick', () => {
    const logs: string[] = []
    const sim = waterSim(floor, { log: (m) => logs.push(m) })
    sim.jobs.start({ kind: 'boom', done: false, step() { throw new Error('boom') }, finish() {}, reset() {}, mixState() {} })
    expect(() => sim.step()).not.toThrow()
    expect(logs.some((m) => /region jobs error tick=0: boom/.test(m))).toBe(true)
    expect(sim.jobs.size).toBe(0)
    expect(sim.water.needsRebuild).toBe(true)
  })
  it('keeps its bodies consistent when a landing write throws: no body lands twice', () => {
    const layout = new Layout([32, 32, 32])
    const world = new Map<number, number>()
    const writes: string[] = []
    let landings = 0
    const g = new GravitySystem({
      layout, registry: new BlockRegistry(WATER_BLOCKS),
      get: (x, y, z) => (y === 0 ? B.stone : world.get(layout.voxelIndex(x, y, z)) ?? AIR),
      write(x, y, z, v) {
        if (v !== AIR && ++landings === 2) throw new Error('write failed')
        world.set(layout.voxelIndex(x, y, z), v)
        if (v !== AIR) writes.push(`${x},${y},${z}`)
      },
    })
    for (const x of [3, 6]) { world.set(layout.voxelIndex(x, 5, 3), B.sand); g.afterWrite(x, 5, 3, B.sand) }
    let threw = 0
    for (let t = 0; t < 40; t++) { try { g.step() } catch { threw++ } }
    expect(threw).toBe(1) // both land in the same step; the second landing's write throws
    expect(writes).toEqual(['3,1,3']) // the first body landed once and was not landed again
    expect(g.count).toBe(0) // the body whose landing threw is dropped, not retried on top of a half-written cell
  })
  it('holds still while physics is paused', () => {
    const sim = waterSim(floor)
    sim.setPaused(true)
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 20, 5], voxel: B.sand })
    run(sim, 5)
    expect(sim.store.getVoxel(5, 20, 5)).toBe(B.sand)
    sim.setPaused(false)
    expect(sim.step().falling).toHaveLength(1)
  })
})
