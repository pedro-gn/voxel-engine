import { describe, expect, it } from 'vitest'
import { AIR } from '../src/world/voxel.ts'
import { B, fluidSim, lake, poolProblems, run, settle, volume, w } from './fluidHelpers.ts'

describe('resurfacing', () => {
  it('moves the whole surface when the balance passes the area', () => {
    const sim = fluidSim(lake(4))
    const [p] = sim.fluids.pools.all()
    const v0 = volume(sim)
    p!.balance = -100 // one level's worth, taken by hand
    run(sim, 2)
    expect(p).toMatchObject({ surfaceY: 4, level: 6, balance: 0, area: 100 })
    expect(volume(sim)).toBe(v0 - 100)
    expect(poolProblems(sim)).toEqual([])
  })
  it('adds a layer when a full pool keeps rising', () => {
    const sim = fluidSim(lake(4))
    const [p] = sim.fluids.pools.all()
    p!.balance = 800
    run(sim, 2)
    expect(p).toMatchObject({ surfaceY: 5, level: 7, area: 100, balance: 0 })
    expect(poolProblems(sim)).toEqual([])
  })
  it('seals a pool under a ceiling instead of rising', () => {
    const base = lake(4)
    const sim = fluidSim((x, y, z) => (y === 5 && x < 12 && z < 12 ? B.stone : base(x, y, z)))
    const [p] = sim.fluids.pools.all()
    p!.balance = 100
    run(sim, 2)
    expect(p).toMatchObject({ surfaceY: 4, level: 7, sealed: true })
    expect(sim.fluids.accepts(p!, 1)).toBe(false)
  })
  it('unseals a pool when its ceiling is removed', () => {
    const base = lake(4)
    const sim = fluidSim((x, y, z) => (y === 5 && x < 12 && z < 12 ? B.stone : base(x, y, z)))
    const [p] = sim.fluids.pools.all()
    p!.balance = 100
    run(sim, 2)
    expect(p!.sealed).toBe(true)
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 5, 5], voxel: AIR })
    run(sim, 1)
    expect(p!.sealed).toBe(false)
    expect(sim.fluids.accepts(p!, 1000)).toBe(true)
    p!.balance = 100
    run(sim, 3)
    expect(p!.surfaceY).toBeGreaterThan(4) // rose through the one-cell hole
  })
  it('unseals a sealed pool that loses a level', () => {
    const base = lake(4)
    const sim = fluidSim((x, y, z) => (y === 5 && x < 12 && z < 12 ? B.stone : base(x, y, z)))
    const [p] = sim.fluids.pools.all()
    p!.balance = 100
    run(sim, 2)
    expect(p!.sealed).toBe(true)
    p!.balance = -p!.area
    run(sim, 2)
    expect(p).toMatchObject({ level: 6, sealed: false })
  })
  it('drops layers and splits a lake over a ridge', () => {
    const base = lake(4)
    const sim = fluidSim((x, y, z) => (x === 6 && y >= 1 && y <= 2 && z > 0 && z < 11 ? B.stone : base(x, y, z)))
    const [p] = sim.fluids.pools.all()
    const v0 = volume(sim)
    p!.balance -= 1600 // two layers' worth
    settle(sim)
    const ps = sim.fluids.pools.all()
    expect(ps.map((q) => [q.surfaceY, q.level, q.area]).sort()).toEqual([[2, 7, 40], [2, 7, 50]])
    expect(volume(sim)).toBe(v0 - 1600)
    expect(poolProblems(sim)).toEqual([])
  })
  it('drains flat through a hole into a cavern below', () => {
    // stone to y = 9 except a cavern (1 ≤ y ≤ 8); a 10 × 10 lake on top (y 10..13) with a hole in its floor
    const sim = fluidSim((x, y, z) => {
      const inLake = x >= 13 && x <= 22 && z >= 13 && z <= 22
      if (y === 0) return B.stone
      if (y <= 8) return x >= 1 && x <= 30 && z >= 1 && z <= 30 ? AIR : B.stone
      if (y === 9) return x === 17 && z === 17 ? AIR : B.stone
      if (y <= 16 && (x === 12 || x === 23 || z === 12 || z === 23) && x >= 12 && x <= 23 && z >= 12 && z <= 23) return B.stone
      return inLake && y <= 13 ? w(7) : AIR
    })
    const v0 = volume(sim)
    for (let t = 0; t < 1000; t++) {
      sim.step()
      expect(volume(sim)).toBe(v0)
      if (t % 25 === 0) expect(poolProblems(sim)).toEqual([])
    }
    let lakeWater = 0
    for (let y = 10; y <= 13; y++) for (let x = 13; x <= 22; x++) for (let z = 13; z <= 22; z++) if (sim.store.getVoxel(x, y, z) !== AIR) lakeWater++
    expect(lakeWater).toBe(0)
  }, 60_000)
  it('rescans a pool whose whole surface a command removed', () => {
    const sim = fluidSim(lake(4))
    const v0 = volume(sim)
    sim.submit(0, 0, { type: 'fillRegion', min: [1, 4, 1], max: [10, 4, 10], voxel: AIR })
    settle(sim)
    const ps = sim.fluids.pools.all()
    expect(ps).toHaveLength(1)
    expect(ps[0]).toMatchObject({ surfaceY: 3, level: 7, area: 100 })
    expect(volume(sim)).toBe(v0 - 800)
    expect(poolProblems(sim)).toEqual([])
  })
  it('stays consistent when a command lands on a frozen pool (review focus 1)', () => {
    // a lake spanning two chunk columns, so a resurface job with jobCap 1 takes two ticks
    const sim = fluidSim((x, y, z) => {
      if (y === 0) return B.stone
      if (y <= 8 && x <= 47 && z <= 11 && (x === 0 || x === 47 || z === 0 || z === 11)) return B.stone // 48 × 12 basin walls
      return x > 0 && x < 47 && z > 0 && z < 11 && y >= 1 && y <= 4 ? w(7) : AIR
    }, { size: [64, 32, 32], jobCap: 1 })
    const [p] = sim.fluids.pools.all()
    const v0 = volume(sim)
    p!.balance = -p!.area
    sim.step() // the job starts and reads the first tile
    expect(p!.frozen).toBe(true)
    sim.submit(0, 0, { type: 'setBlock', pos: [40, 4, 5], voxel: B.stone }) // lands mid-job
    settle(sim)
    expect(volume(sim)).toBe(v0 - 460)
    expect(poolProblems(sim)).toEqual([])
  })
})
