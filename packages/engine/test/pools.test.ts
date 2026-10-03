import { describe, expect, it } from 'vitest'
import { AIR } from '../src/world/voxel.ts'
import { B, fluidSim, lake, poolProblems, run, settle, volume, w } from './fluidHelpers.ts'

const units = (v: number) => ((v & 0xfff) === B.water ? ((v >>> 12) & 7) + 1 : 0)

describe('pools and moving water', () => {
  it('absorbs water falling onto its surface', () => {
    const sim = fluidSim(lake(4))
    const [p] = sim.fluids.pools.all()
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 5, 5], voxel: w(3) })
    sim.step()
    expect(sim.store.getVoxel(5, 5, 5)).toBe(AIR)
    expect(p!.balance).toBe(4)
    expect(poolProblems(sim)).toEqual([])
  })
  it('refills a cell dug out of its surface and takes it back', () => {
    const sim = fluidSim(lake(4))
    const [p] = sim.fluids.pools.all()
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 4, 5], voxel: AIR })
    run(sim, 3)
    expect(units(sim.store.getVoxel(5, 4, 5))).toBe(8)
    expect(sim.fluids.poolAt(5, 4, 5)).toBe(p)
    expect(p!.area).toBe(100)
    expect(poolProblems(sim)).toEqual([])
  })
  it('floods a tunnel under a ceiling and takes its cells in', () => {
    // a tunnel at y = 1, z = 5, running east from the lake through the wall to x = 20, with stone above it
    const base = lake(4)
    const sim = fluidSim((x, y, z) => {
      if (y === 0) return B.stone
      if (x >= 11 && x <= 20 && z >= 4 && z <= 6 && y <= 3) return y === 1 && z === 5 && x < 20 && x > 11 ? AIR : B.stone
      return base(x, y, z)
    })
    const [p] = sim.fluids.pools.all()
    const v0 = volume(sim)
    sim.submit(0, 0, { type: 'setBlock', pos: [11, 1, 5], voxel: AIR }) // open the wall
    sim.step() // applies the command; settle() returns at once while nothing is active
    settle(sim)
    for (let x = 11; x < 20; x++) expect(sim.fluids.poolAt(x, 1, 5)).toBe(p)
    expect(volume(sim)).toBe(v0)
    expect(poolProblems(sim)).toEqual([])
  })
  it('pours out through a breach onto a lower floor as moving water', () => {
    // the east wall is open at the surface layer; outside, the floor is y = 0
    const base = lake(4)
    const sim = fluidSim((x, y, z) => (x === 11 && y === 4 && z === 5 ? AIR : base(x, y, z)), { size: [64, 32, 32] })
    const v0 = volume(sim)
    run(sim, 40)
    let outside = 0
    for (let x = 12; x < 64; x++) for (let z = 0; z < 32; z++) for (let y = 1; y < 8; y++) outside += units(sim.store.getVoxel(x, y, z))
    expect(outside).toBeGreaterThan(0)
    expect(volume(sim)).toBe(v0)
  })
  it('settles a resting puddle into a flat pool', () => {
    const sim = fluidSim((x, y, z) => (y === 0 ? B.stone : (x === 3 || x === 7 || z === 3 || z === 7) && y <= 3 ? B.stone : AIR))
    sim.submit(0, 0, { type: 'fillRegion', min: [4, 1, 4], max: [6, 2, 6], voxel: w(7) })
    sim.step()
    settle(sim)
    const ps = sim.fluids.pools.all()
    expect(ps).toHaveLength(1)
    expect(ps[0]).toMatchObject({ surfaceY: 2, level: 7, area: 9 })
    expect(poolProblems(sim)).toEqual([])
  })
})
