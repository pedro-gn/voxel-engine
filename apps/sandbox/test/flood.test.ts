import { Simulation } from '@elovox/engine/src/sim/simulation.ts'
import { createWorldBuffers } from '@elovox/engine/src/world/buffers.ts'
import { MIN_FLOW } from '@elovox/engine/src/sim/water/constants.ts'
import { SUB } from '@elovox/engine/src/world/waterBuffers.ts'
import { describe, expect, it } from 'vitest'
import { BLOCKS } from '../src/blocks.ts'
import rules from '../src/rules.ts'
import {
  BREACH, CHANNEL, DAM_X, FLOOD_SIZE, GROUND, LAKE, PILLARS, SEA_LEVEL, SPRING, VALLEY,
  breachCommands, digCommands, dropCommands, floodColumn, floodGenerator, stopSpringCommands, stressCommands,
} from '../src/scenes/flood.ts'

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
  it('stops the spring by putting the given stone voxel on its cell', () => {
    const y = floodColumn(SPRING.x, SPRING.z).indexOf('spring')
    expect(stopSpringCommands(7)).toEqual([{ type: 'setBlock', pos: [SPRING.x, y, SPRING.z], voxel: 7 }])
  })
  it('digs a channel west of the lake through the ground, down to the lake floor', () => {
    expect(digCommands()).toEqual([{ type: 'fillRegion', min: [CHANNEL.x0, LAKE.floor, CHANNEL.z0], max: [CHANNEL.x1, GROUND - 1, CHANNEL.z1], voxel: 0 }])
    expect(CHANNEL.x1).toBe(LAKE.x0 - 1) // it opens straight into the lake
    for (const x of [CHANNEL.x0, CHANNEL.x1]) expect(floodColumn(x, CHANNEL.z0)[LAKE.floor]).not.toBeNull() // ground there now
    expect(floodColumn(CHANNEL.x0, CHANNEL.z0)[GROUND - 1]).not.toBeNull() // the dig's top layer is ground too
    for (const [x, z] of [[CHANNEL.x0, CHANNEL.z0 - 1], [CHANNEL.x0, CHANNEL.z1 + 1], [CHANNEL.x0 - 1, CHANNEL.z0]] as const) {
      expect(floodColumn(x, z)[LAKE.floor]).not.toBeNull() // the walls stay solid
      expect(floodColumn(x, z)[GROUND - 1]).not.toBeNull()
    }
  })
  it('stress: opens the whole dam and drops a 40 × 40 × 4 block of the given water voxel over the valley', () => {
    const [dam, dump] = stressCommands(99)
    expect(dam).toEqual({ type: 'fillRegion', min: [DAM_X, LAKE.floor, LAKE.z0], max: [DAM_X, LAKE.top, LAKE.z1], voxel: 0 })
    expect(dump).toMatchObject({ type: 'fillRegion', voxel: 99 })
    const { min, max } = dump as unknown as { min: number[]; max: number[] }
    expect([max[0]! - min[0]! + 1, max[1]! - min[1]! + 1, max[2]! - min[2]! + 1]).toEqual([40, 4, 40])
    for (let x = min[0]!; x <= max[0]!; x += 13) for (let z = min[2]!; z <= max[2]!; z += 13) {
      const col = floodColumn(x, z)
      expect(x >= VALLEY.x0 && x <= VALLEY.x1 && z >= VALLEY.z0 && z <= VALLEY.z1).toBe(true)
      expect(col.slice(min[1]!, max[1]! + 1).every((b) => b === null)).toBe(true) // in the air above the valley
    }
  })
})

describe('flood scene simulation', () => {
  it('rebuilds the lake, the sea and the spring from the voxels, and a breach pours the lake into the valley', () => {
    const sim = new Simulation({ buffers: createWorldBuffers([...FLOOD_SIZE]), blocks: BLOCKS, rules, seed: 1, log: () => {} })
    sim.configure(floodGenerator, {})
    sim.generate(floodGenerator)
    expect(sim.water.column(60, 60)).toMatchObject({ floor: LAKE.floor, depth: (LAKE.top + 1 - LAKE.floor) * SUB })
    // the pillar's planks over the lake split its column: the lake runs on under them
    expect(sim.water.segments(70, 70)[0]).toMatchObject({ floor: LAKE.floor, ceil: PILLARS[1].base, depth: (LAKE.top + 1 - LAKE.floor) * SUB })
    expect(sim.water.cycle.mask[50 + 230 * FLOOD_SIZE[0]]).toBe(1)
    expect(sim.water.cycle.springs.size).toBe(1)
    const lake0 = sim.water.column(LAKE.x1, 75).depth
    breachCommands().forEach((c, i) => sim.submit(0, i, c))
    for (let t = 0; t < 80; t++) sim.step()
    let valley = 0
    for (let x = VALLEY.x0; x < VALLEY.x0 + 24; x++) for (let z = BREACH.z0 - 12; z <= BREACH.z1 + 12; z++) valley += sim.water.column(x, z).depth
    expect(valley).toBeGreaterThan(0)
    expect(sim.water.column(LAKE.x1, 75).depth).toBeLessThan(lake0)
  }, 180_000)
  it('with the spring stopped, a breached lake drains into the valley, keeping Σ depth + sea exact every tick', () => {
    // Bounded: the whole dam break settles only after ~18 000 ticks (about 9 minutes in Node); the benchmark and the e2e
    // cover settling. Here the lake must go down, the valley fill, and no tick may lose or make water.
    const logs: string[] = []
    const sim = new Simulation({
      buffers: createWorldBuffers([...FLOOD_SIZE]), blocks: BLOCKS, rules, seed: 1, randomTicksPerChunk: 0,
      log: (m) => logs.push(m), water: { debug: true },
    })
    sim.configure(floodGenerator, {})
    sim.generate(floodGenerator)
    const v0 = sim.water.total()
    const lake0 = sim.water.column(60, 60).surface
    ;[...stopSpringCommands(sim.registry.id('stone')), ...breachCommands()].forEach((c, i) => sim.submit(0, i, c))
    let off = 0
    for (let t = 0; t < 3000; t++) {
      sim.step()
      if (sim.water.total() !== v0) off++
    }
    expect(off).toBe(0)
    expect(sim.water.column(60, 60).surface).toBeLessThan(lake0)
    let valley = 0
    for (let x = VALLEY.x0; x <= VALLEY.x1; x++) for (let z = VALLEY.z0; z <= VALLEY.z1; z++) valley += sim.water.column(x, z).depth
    expect(valley).toBeGreaterThan(100 * SUB)
    expect(sim.water.cycle.springs.size).toBe(0)
    expect(logs).toEqual([])
    expect(sim.water.expected).toBe(v0)
    expect(sim.water.check()).toEqual([])
  }, 300_000)
  it('a channel dug beside the lake fills; the lake goes down by what the channel holds plus a rim film thinner than MIN_FLOW', () => {
    const sim = new Simulation({ buffers: createWorldBuffers([...FLOOD_SIZE]), blocks: BLOCKS, rules, seed: 1, randomTicksPerChunk: 0, log: () => {} })
    sim.configure(floodGenerator, {})
    sim.generate(floodGenerator)
    const sum = (x0: number, z0: number, x1: number, z1: number) => {
      let s = 0
      // every segment: the lake runs on under the pillars' planks as lower segments
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) for (const g of sim.water.segments(x, z)) s += g.depth
      return s
    }
    // The lake is brim-full: a wave overshoot leaves a film (a few 1/SUB) on its north, south and east rim (the dam top).
    const rim = () => sum(LAKE.x0, LAKE.z0 - 1, LAKE.x1 + 1, LAKE.z0 - 1) + sum(LAKE.x0, LAKE.z1 + 1, LAKE.x1 + 1, LAKE.z1 + 1) + sum(LAKE.x1 + 1, LAKE.z0, LAKE.x1 + 1, LAKE.z1)
    const lake0 = sum(LAKE.x0, LAKE.z0, LAKE.x1, LAKE.z1), rim0 = rim()
    digCommands().forEach((c, i) => sim.submit(0, i, c))
    // 600 ticks: the channel (20 × 4 columns) holds over 3 blocks a column by then; the lake drop is what the channel and the rim gained.
    // (Longer, the faster water lets the river's film reach the lake's corner and a few 1/SUB cross in from outside.)
    for (let t = 0; t < 600; t++) sim.step()
    const channel = sum(CHANNEL.x0, CHANNEL.z0, CHANNEL.x1, CHANNEL.z1)
    const area = (CHANNEL.x1 - CHANNEL.x0 + 1) * (CHANNEL.z1 - CHANNEL.z0 + 1)
    expect(channel).toBeGreaterThan(area * 3 * SUB)
    const spill = rim() - rim0
    expect(spill).toBeGreaterThanOrEqual(0)
    expect(spill).toBeLessThan(MIN_FLOW) // a film that thin never flows off the rim
    expect(lake0 - sum(LAKE.x0, LAKE.z0, LAKE.x1, LAKE.z1)).toBe(channel + spill)
  }, 180_000)
})
