import { describe, expect, it } from 'vitest'
import { SPRING_RATES } from '../src/sim/fluids/cell.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, basin, fluidSim, lake, poolProblems, run, settle, spring, volume, w } from './fluidHelpers.ts'

describe('pools in contact', () => {
  it('evens out stepped water and merges it into one flat pool', () => {
    const b = basin(12, 8)
    const sim = fluidSim((x, y, z) => {
      const v = b(x, y, z)
      if (v !== AIR) return v
      if (x <= 0 || x >= 11 || z <= 0 || z >= 11 || y < 1) return AIR
      return y <= (x < 6 ? 4 : 3) ? w(7) : AIR
    })
    const v0 = volume(sim)
    settle(sim)
    const ps = sim.fluids.pools.all()
    expect(ps).toHaveLength(1)
    expect(ps[0]).toMatchObject({ surfaceY: 4, level: 3, area: 100, balance: 0 })
    expect(volume(sim)).toBe(v0)
    expect(poolProblems(sim)).toEqual([])
  })
  it('raises water in a shaft to the lake level through a tunnel (communicating vessels)', () => {
    // lake x 1..10, water y 1..6, walls to y 9; tunnel at y = 1, z = 5 from x = 11 to 15 under a stone ceiling; shaft at x = 16 up to y = 12
    const base = lake(6, 12, 9)
    const sim = fluidSim((x, y, z) => {
      if (y === 0) return B.stone
      if (x >= 11 && x <= 17 && z >= 4 && z <= 6 && y <= 12) {
        if (z === 5 && y === 1 && x >= 12 && x <= 16) return AIR // the tunnel (x = 11 stays wall until dug)
        if (z === 5 && x === 16 && y >= 2) return AIR // the shaft
        return B.stone
      }
      return base(x, y, z)
    })
    const v0 = volume(sim)
    sim.submit(0, 0, { type: 'setBlock', pos: [11, 1, 5], voxel: AIR })
    settle(sim)
    const lakePool = sim.fluids.poolAt(5, 1, 5)!
    expect(sim.fluids.poolAt(16, lakePool.surfaceY, 5)).toBe(lakePool)
    expect(sim.store.getVoxel(16, lakePool.surfaceY + 1, 5)).toBe(AIR)
    expect(volume(sim)).toBe(v0)
    expect(poolProblems(sim)).toEqual([])
  })
  it('settles when a full sealed pool touches a higher one (no endless pending contact)', () => {
    const base = lake(6, 12, 9)
    const sim = fluidSim((x, y, z) => {
      if (y === 0) return B.stone
      if (x >= 11 && x <= 17 && z >= 4 && z <= 6 && y <= 12) {
        if (z === 5 && y === 1 && x >= 12 && x <= 16) return w(7) // a flooded tunnel
        if (z === 5 && x === 16 && y === 2) return w(7) // a one-cell shaft, ceiling above
        return B.stone
      }
      return base(x, y, z)
    })
    const v0 = volume(sim)
    sim.submit(0, 0, { type: 'setBlock', pos: [11, 1, 5], voxel: AIR })
    expect(() => settle(sim)).not.toThrow()
    expect(sim.fluids.contactsPending()).toBe(false)
    expect(volume(sim)).toBe(v0)
    expect(poolProblems(sim)).toEqual([])
  })
})

describe('springs', () => {
  /** A sea (y 1..3, seaLevel 4) for x < 40, a stone hill (to y = 10) for x ≥ 40. */
  const coast = (x: number, y: number) => (y === 0 ? B.stone : x >= 40 ? (y <= 10 ? B.stone : AIR) : y <= 3 ? w(7) : AIR)

  it('draws from the sea, so total volume never changes', () => {
    const sim = fluidSim((x, y, z) => (x === 50 && y === 11 && z === 16 ? spring(5) : coast(x, y)), { size: [64, 32, 32], seaLevel: 4 })
    const sea = sim.fluids.cycle!
    expect(sea).toMatchObject({ surfaceY: 3, cycle: true })
    const v0 = volume(sim)
    for (let t = 0; t < 40; t++) { sim.step(); expect(volume(sim)).toBe(v0) }
    expect(sea.balance + (sea.level + 1 - 8) * sea.area).toBeLessThan(0) // the sea gave water
    let hill = 0
    for (let x = 40; x < 64; x++) for (let z = 0; z < 32; z++) for (let y = 11; y < 20; y++) if ((sim.store.getVoxel(x, y, z) & 0xfff) === B.water) hill++
    expect(hill).toBeGreaterThan(0)
  })
  it('is an infinite source when the world has no sea', () => {
    const sim = fluidSim((x, y, z) => (y === 0 ? B.stone : x === 16 && y === 1 && z === 16 ? spring(5) : AIR))
    sim.step()
    expect(volume(sim)).toBe(SPRING_RATES[5])
  })
  it('never makes water in a world with a sea level: not once the sea is gone, not after a rebuild, not without a sea at all', () => {
    const hillSpring = (x: number, y: number, z: number) => (x === 50 && y === 11 && z === 16 ? spring(5) : coast(x, y))
    const sim = fluidSim(hillSpring, { size: [64, 32, 32], seaLevel: 4 })
    sim.submit(0, 0, { type: 'fillRegion', min: [0, 1, 0], max: [39, 3, 31], voxel: AIR }) // the sea is pumped away
    run(sim, 5)
    expect(sim.fluids.cycle).toBeUndefined()
    const v0 = volume(sim)
    run(sim, 5)
    expect(volume(sim)).toBe(v0)
    sim.fluids.needsRebuild = true // an editor regeneration rescans the world
    run(sim, 5)
    expect(volume(sim)).toBe(v0)
    // configured with a sea level, generated without a pool at seaLevel − 1
    const dry = fluidSim((x, y, z) => (x === 50 && y === 11 && z === 16 ? spring(5) : x < 40 && y >= 1 ? AIR : coast(x, y)), { size: [64, 32, 32], seaLevel: 4 })
    expect(dry.fluids.cycle).toBeUndefined()
    run(dry, 5)
    expect(volume(dry)).toBe(0)
  })
  it('gives nothing next to the sea, stops when removed, and stays shut when walled in (review focus 5)', () => {
    const sim = fluidSim((x, y, z) => {
      if (x === 5 && y === 2 && z === 5) return spring(9)
      if (x === 50 && y === 11 && z === 16) return spring(9)
      if (x >= 49 && x <= 51 && y >= 10 && y <= 12 && z >= 15 && z <= 17) return B.stone // walls in the hill spring
      return coast(x, y)
    }, { size: [64, 32, 32], seaLevel: 4 })
    const v0 = volume(sim)
    run(sim, 10)
    expect(volume(sim)).toBe(v0)
    expect(sim.fluids.cycle!.balance).toBe(0)
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 2, 5], voxel: AIR })
    run(sim, 3)
    expect(sim.fluids.springs.has(sim.layout.voxelIndex(5, 2, 5))).toBe(false)
    expect(volume(sim)).toBe(v0)
  })
})
