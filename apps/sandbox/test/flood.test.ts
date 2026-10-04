import { Simulation } from '@elovox/engine/src/sim/simulation.ts'
import { createWorldBuffers } from '@elovox/engine/src/world/buffers.ts'
import { describe, expect, it } from 'vitest'
import { BLOCKS } from '../src/blocks.ts'
import rules from '../src/rules.ts'
import { BREACH, DAM_X, FLOOD_SIZE, LAKE, PILLARS, SEA_LEVEL, SPRING, VALLEY, breachCommands, dropCommands, floodColumn, floodGenerator } from '../src/scenes/flood.ts'

describe('flood scene layout', () => {
  it('holds a lake behind a one-block dam above a dry valley', () => {
    const lake = floodColumn(60, 60)
    expect(lake.slice(LAKE.floor, LAKE.top + 1).every((b) => b === 'water')).toBe(true)
    expect(lake[LAKE.floor - 1]).toBe('dirt')
    expect(lake[LAKE.top + 1]).toBeNull()
    expect(floodColumn(DAM_X, 75)[LAKE.top]).not.toBeNull()
    const valley = floodColumn(DAM_X + 1, 75)
    expect(valley[VALLEY.ground - 1]).toBe('grass')
    expect(valley[VALLEY.ground]).toBeNull()
  })
  it('has a spring on the river bed, a sea below the sea level and sand on planks in the air', () => {
    const head = floodColumn(SPRING.x, SPRING.z)
    const y = head.indexOf('spring')
    expect(y).toBeGreaterThan(0)
    expect(head[y - 1]).not.toBeNull()
    expect(floodColumn(50, 230)[SEA_LEVEL - 1]).toBe('water')
    expect(floodColumn(50, 230)[SEA_LEVEL]).toBeNull()
    const p = PILLARS[0]
    const col = floodColumn(p.x, p.z)
    expect(col[p.base]).toBe('planks')
    expect(col[p.base - 1]).toBeNull()
    expect(col.slice(p.base + 1, p.base + 1 + p.height).every((b) => b === 'sand')).toBe(true)
  })
  it('breaches the dam down to the lake floor and drops the pillars by removing their planks', () => {
    expect(breachCommands()).toEqual([{ type: 'fillRegion', min: [DAM_X, LAKE.floor, BREACH.z0], max: [DAM_X, LAKE.top, BREACH.z1], voxel: 0 }])
    expect(dropCommands()).toEqual(PILLARS.map((q) => ({ type: 'setBlock', pos: [q.x, q.base, q.z], voxel: 0 })))
  })
})

describe('flood scene simulation', () => {
  it('makes the lake and the sea pools, and a breach pours the lake into the valley', () => {
    const sim = new Simulation({ buffers: createWorldBuffers([...FLOOD_SIZE]), blocks: BLOCKS, rules, seed: 1, log: () => {}, fluids: { fluidEvery: 1 } })
    sim.configure(floodGenerator, {})
    sim.generate(floodGenerator)
    const lake = sim.fluids.poolAt(60, LAKE.floor, 60)!
    expect(lake).toMatchObject({ surfaceY: LAKE.top, area: 100 * 100 })
    expect(sim.fluids.cycle).toMatchObject({ surfaceY: SEA_LEVEL - 1 })
    breachCommands().forEach((c, i) => sim.submit(0, i, c))
    for (let t = 0; t < 80; t++) sim.step()
    const water = sim.registry.id('water')
    let valley = 0
    for (let x = VALLEY.x0; x < VALLEY.x0 + 24; x++) for (let z = BREACH.z0 - 12; z <= BREACH.z1 + 12; z++) {
      for (let y = VALLEY.ground; y < VALLEY.ground + 3; y++) if ((sim.store.getVoxel(x, y, z) & 0xfff) === water) valley++
    }
    expect(valley).toBeGreaterThan(0)
    expect((lake.level - 7) * lake.area + lake.balance).toBeLessThan(0) // the lake gave water
  }, 180_000)
})
