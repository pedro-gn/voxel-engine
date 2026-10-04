import { describe, expect, it } from 'vitest'
import { defineBlock } from '../src/blocks/registry.ts'
import { SPRING_RATES } from '../src/sim/fluids/cell.ts'
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
  const cell = (sim: ReturnType<typeof fluidSim>, y: number) => units(sim.store.getVoxel(16, y, 16))
  it.each([3, 5, 7, 9, 12])('spring(%i) keeps a contiguous column and conserves volume', (rate) => {
    const sim = fluidSim((x, y, z) => (y === 0 ? B.stone : x === 16 && y === 26 && z === 16 ? spring(rate) : AIR))
    let prev = 0
    for (let t = 1; t <= 200; t++) {
      sim.step()
      // the spring gives at most its rate (one cell takes at most 8), and what it gives is the only volume change
      const inc = volume(sim) - prev
      if (inc < 0 || inc > SPRING_RATES[rate]!) expect.fail(`injected ${inc} at tick ${t}`)
      prev = volume(sim)
      if (t < 60) continue
      for (let y = 1; y <= 25; y++) if (cell(sim, y) === 0) expect.fail(`gap at y=${y}, tick ${t}`)
    }
    // remove the source: from then on the volume is exactly constant
    sim.submit(0, 0, { type: 'setBlock', pos: [16, 26, 16], voxel: AIR })
    sim.step()
    const before = volume(sim)
    for (let t = 0; t < 30; t++) { sim.step(); if (volume(sim) !== before) expect.fail('volume changed after the source was removed') }
    expect(sim.fluids.lost).toBe(0)
  })
  it('stays contiguous while the front falls, then conserves volume once the source is removed', () => {
    const sim = fluidSim((x, y, z) => (y === 0 ? B.stone : x === 16 && y === 26 && z === 16 ? spring(9) : AIR))
    run(sim, 30)
    for (let t = 0; t < 5; t++) {
      sim.step()
      for (let y = 1; y <= 25; y++) if (cell(sim, y) === 0) expect.fail(`gap at y=${y}, front tick ${t}`)
    }
    sim.submit(0, 0, { type: 'setBlock', pos: [16, 26, 16], voxel: AIR })
    sim.step()
    const before = volume(sim)
    for (let t = 0; t < 40; t++) { sim.step(); expect(volume(sim)).toBe(before) }
    settle(sim)
    expect(volume(sim)).toBe(before)
    expect(sim.fluids.lost).toBe(0)
  })
})

describe('side-fed fall', () => {
  // A reservoir (x ≤ 20, bed below y = 20, full water from y = 20 up `h` rows) whose east wall at x = 21 opens over
  // z 8..11, down to the bed. The opening's cells rest on the bed and feed sideways the columns at x = 22, which fall
  // to the floor at y = 0 (the dam-break lip of the sandbox's flood scene).
  const F = 20, D = 21, Z0 = 8, Z1 = 11
  it.each([2, 3, 4])('a lip %i rows high feeds its falls without gaps', (h) => {
    const top = F + h - 1
    const sim = fluidSim((x, y, z) => {
      if (y === 0) return B.stone
      if (x > D) return AIR
      if (y < F) return B.stone
      if (x === 0 || x === D || z === 0 || z === 31) return y <= top + 1 ? B.stone : AIR
      return y <= top ? w(7) : AIR
    }, { size: [64, 32, 32] })
    sim.submit(0, 0, { type: 'fillRegion', min: [D, F, Z0], max: [D, top, Z1], voxel: AIR })
    sim.step()
    const before = volume(sim)
    for (let t = 2; t <= 300; t++) {
      sim.step()
      if (t < 60) continue
      // above the landing (the pool at the bottom rises to about y = 2), every falling column is water up to its top
      for (let z = Z0; z <= Z1; z++) {
        let wTop = 0
        for (let y = 4; y <= top; y++) if (units(sim.store.getVoxel(D + 1, y, z)) > 0) wTop = y
        for (let y = 4; y < wTop; y++) if (units(sim.store.getVoxel(D + 1, y, z)) === 0) expect.fail(`gap at (${D + 1}, ${y}, ${z}), tick ${t}`)
      }
    }
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
