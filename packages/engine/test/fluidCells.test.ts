import { describe, expect, it } from 'vitest'
import { defineBlock } from '../src/blocks/registry.ts'
import { AIR, packVoxel } from '../src/world/voxel.ts'
import { B, FLUID_BLOCKS, basin, fluidSim, run, settle, spring, volume, w } from './fluidHelpers.ts'

const level = (v: number) => (v >>> 12) & 7
const units = (v: number) => ((v & 0xfff) === B.water ? level(v) + 1 : 0)

/** Stone floor at y = 0 only. */
const floor = (x: number, y: number, z: number) => (y === 0 ? B.stone : AIR)

describe('cell automaton', () => {
  it('drops a cell straight down and keeps its volume', () => {
    const sim = fluidSim(floor)
    sim.submit(0, 0, { type: 'setBlock', pos: [10, 12, 10], voxel: w(7) })
    const before = 8
    for (let t = 0; t < 30; t++) { sim.step(); expect(volume(sim)).toBe(before) }
    expect(units(sim.store.getVoxel(10, 12, 10))).toBe(0)
    let below = 0
    for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) below += units(sim.store.getVoxel(x, 1, z))
    expect(below).toBe(8)
  })
  it('spreads on a flat floor until no neighbours differ by 2 or more, then sleeps', () => {
    const sim = fluidSim(floor)
    sim.submit(0, 0, { type: 'setBlock', pos: [16, 1, 16], voxel: w(7) })
    sim.step()
    settle(sim)
    expect(volume(sim)).toBe(8)
    for (let x = 1; x < 31; x++) for (let z = 1; z < 31; z++) {
      const u = units(sim.store.getVoxel(x, 1, z))
      for (const [dx, dz] of [[1, 0], [0, 1]] as const) expect(Math.abs(u - units(sim.store.getVoxel(x + dx, 1, z + dz)))).toBeLessThan(2)
    }
    expect(sim.fluids.activeCount).toBe(0)
  })
  it('prefers a side that leads to a drop within reach', () => {
    // a ledge at y ≤ 4 for x < 20; at x ≥ 20 the floor is y = 0
    const sim = fluidSim((x, y) => (y === 0 || (x < 20 && y <= 4) ? B.stone : AIR))
    sim.submit(0, 0, { type: 'setBlock', pos: [18, 5, 10], voxel: w(7) })
    sim.step() // the command lands; the fluid step runs the same tick
    expect(units(sim.store.getVoxel(19, 5, 10))).toBeGreaterThan(0)
    expect(units(sim.store.getVoxel(17, 5, 10))).toBe(0)
  })
  it('processes at most fluidCap cells per step, in order', () => {
    const sim = fluidSim(floor, { fluids: { fluidCap: 1 } })
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 10, 5], voxel: w(7) })
    sim.submit(0, 1, { type: 'setBlock', pos: [20, 10, 20], voxel: w(7) })
    sim.step()
    expect(units(sim.store.getVoxel(5, 9, 5))).toBe(8)
    expect(units(sim.store.getVoxel(20, 10, 20))).toBe(8) // still waiting its turn
  })
  it('stays inside the world at every edge', () => {
    const sim = fluidSim(() => AIR)
    sim.submit(0, 0, { type: 'setBlock', pos: [0, 0, 0], voxel: w(7) })
    sim.submit(0, 1, { type: 'setBlock', pos: [31, 31, 31], voxel: w(7) })
    sim.submit(0, 2, { type: 'setBlock', pos: [31, 0, 0], voxel: w(7) })
    sim.step()
    settle(sim)
    expect(volume(sim)).toBe(24)
    expect(sim.fluids.lost).toBe(0)
  })
})

describe('falling column', () => {
  it('stays contiguous under a constant source and conserves volume', () => {
    const sim = fluidSim((x, y, z) => (y === 0 ? B.stone : x === 16 && y === 26 && z === 16 ? spring(9) : AIR))
    run(sim, 30)
    for (let t = 0; t < 5; t++) {
      sim.step()
      for (let y = 1; y <= 25; y++) expect(units(sim.store.getVoxel(16, y, 16)), `gap at y=${y}, step ${t}`).toBeGreaterThan(0)
    }
    // remove the source: what is left only moves around
    sim.submit(0, 0, { type: 'setBlock', pos: [16, 26, 16], voxel: AIR })
    sim.step()
    const before = volume(sim)
    for (let t = 0; t < 40; t++) { sim.step(); expect(volume(sim)).toBe(before) }
    settle(sim)
    expect(volume(sim)).toBe(before)
    expect(sim.fluids.lost).toBe(0)
  })
})

describe('two liquids', () => {
  it('never turns one liquid into another when both flow into the same air cell', () => {
    const lava = defineBlock({ name: 'lava', liquid: true, textures: 'water' })
    const sim = fluidSim(floor, { blocks: [...FLUID_BLOCKS, lava] })
    const lavaId = FLUID_BLOCKS.length + 1 // ids start at 1 after air
    sim.submit(0, 0, { type: 'setBlock', pos: [10, 1, 10], voxel: w(7) })
    sim.submit(0, 1, { type: 'setBlock', pos: [12, 1, 10], voxel: packVoxel(lavaId, 7) })
    sim.step()
    const count = (id: number) => {
      let n = 0
      for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) {
        const v = sim.store.getVoxel(x, 1, z)
        if ((v & 0xfff) === id) n += level(v) + 1
      }
      return n
    }
    const mid = sim.store.getVoxel(11, 1, 10)
    expect([0, B.water, lavaId]).toContain(mid & 0xfff)
    expect(count(B.water)).toBe(8)
    expect(count(lavaId)).toBe(8)
  })
})

describe('external writes', () => {
  it('displaces loose water up when a solid replaces it', () => {
    const sim = fluidSim(floor)
    sim.submit(0, 0, { type: 'setBlock', pos: [10, 1, 10], voxel: w(3) })
    sim.step()
    const v0 = volume(sim)
    sim.submit(0, 1, { type: 'fillRegion', min: [8, 1, 8], max: [12, 1, 12], voxel: B.stone })
    sim.step()
    expect(volume(sim)).toBe(v0)
  })
  it('credits a pool when a solid replaces one of its cells, and loses what a command deletes', () => {
    const b = basin(12, 8)
    const sim = fluidSim((x, y, z) => (b(x, y, z) !== AIR ? b(x, y, z) : x > 0 && x < 11 && z > 0 && z < 11 && y >= 1 && y <= 4 ? w(7) : AIR))
    const [p] = sim.fluids.pools.all()
    const v0 = volume(sim)
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 2, 5], voxel: B.stone })
    sim.step()
    expect(volume(sim)).toBe(v0)
    expect(p!.balance).toBe(8)
    expect(sim.fluids.members.has(5, 2, 5)).toBe(false)
    sim.submit(0, 1, { type: 'setBlock', pos: [6, 4, 6], voxel: AIR })
    sim.step()
    expect(volume(sim)).toBe(v0 - 8)
    expect(p!.area).toBe(99)
  })
})
