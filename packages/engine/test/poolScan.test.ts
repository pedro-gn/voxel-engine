import { describe, expect, it } from 'vitest'
import { AIR } from '../src/world/voxel.ts'
import { B, basin, fluidSim, w, spring, type Fill } from './fluidHelpers.ts'

/** A basin of side 12 with walls to y = 8, filled with full water for 1 ≤ y ≤ top. */
const lake = (top: number): Fill => {
  const b = basin(12, 8)
  return (x, y, z) => {
    const v = b(x, y, z)
    if (v !== AIR) return v
    return x > 0 && x < 11 && z > 0 && z < 11 && y >= 1 && y <= top ? w(7) : AIR
  }
}

describe('rebuild', () => {
  it('turns a still lake into one flat pool', () => {
    const sim = fluidSim(lake(4))
    const pools = sim.fluids.pools.all()
    expect(pools).toHaveLength(1)
    expect(pools[0]).toMatchObject({ surfaceY: 4, level: 7, area: 100, grid: 400 * 8, balance: 0 })
    expect(pools[0]!.outlets.size).toBe(0)
    expect(sim.fluids.poolAt(5, 1, 5)).toBe(pools[0])
    expect(sim.fluids.members.count()).toBe(400)
    expect(sim.fluids.activeCount).toBe(0)
  })
  it('keeps two separate lakes apart', () => {
    const one = lake(3)
    const sim = fluidSim((x, y, z) => (x === 6 && y >= 1 && y <= 8 ? B.stone : one(x, y, z)))
    expect(sim.fluids.pools.all().map((p) => p.area).sort()).toEqual([40, 50])
  })
  it('owns a cave below the bed through a capped top', () => {
    const b = lake(4)
    const sim = fluidSim((x, y, z) => {
      if (y === 0) return B.stone
      if (y <= 2 && x >= 3 && x <= 6 && z >= 3 && z <= 6) return y === 2 && !(x === 3 && z === 3) ? B.stone : w(7) // a cave at y = 1 under a lid with one hole
      if (y <= 2) return B.stone
      return b(x, y, z)
    })
    const [p] = sim.fluids.pools.all()
    expect(sim.fluids.pools.all()).toHaveLength(1)
    expect(sim.fluids.poolAt(5, 1, 5)).toBe(p)
    expect(p!.capped.size).toBeGreaterThan(0)
  })
  it('splits stepped water into pools in contact', () => {
    // west half: water to y = 4; east half: water to y = 3; one body below y = 3
    const b = basin(12, 8)
    const sim = fluidSim((x, y, z) => {
      const v = b(x, y, z)
      if (v !== AIR) return v
      if (x <= 0 || x >= 11 || z <= 0 || z >= 11 || y < 1) return AIR
      return y <= (x < 6 ? 4 : 3) ? w(7) : AIR
    })
    const ps = sim.fluids.pools.all()
    expect(ps.map((p) => p.surfaceY).sort()).toEqual([3, 4])
    expect(sim.fluids.contacts.size).toBe(1)
  })
  it('records outlets, wakes loose water and finds springs', () => {
    const b = lake(4)
    const sim = fluidSim((x, y, z) => {
      if (x === 5 && z === 5 && y === 0) return AIR // a hole in the floor under the lake
      if (x === 20 && z === 20 && y === 1) return w(2) // a puddle cell on its own floor tile
      if (x === 20 && z === 20 && y === 0) return B.stone
      if (x === 25 && z === 25 && y === 1) return spring(3)
      return b(x, y, z)
    })
    const [p] = sim.fluids.pools.all().filter((q) => q.area === 100)
    expect(p!.outlets.has(sim.layout.voxelIndex(5, 0, 5))).toBe(true)
    expect(sim.fluids.springs.has(sim.layout.voxelIndex(25, 1, 25))).toBe(true)
    expect(sim.fluids.pools.all()).toHaveLength(2) // the puddle is a pool of its own
  })
  it('handles a chunk that is entirely water', () => {
    const sim = fluidSim((_x, y) => (y <= 40 ? w(7) : AIR), { size: [32, 64, 32] })
    expect(sim.store.slotOf(0)).toBe(-1) // the bottom chunk is uniform: no slot
    const [p] = sim.fluids.pools.all()
    expect(p).toMatchObject({ surfaceY: 40, level: 7, area: 1024, grid: 41 * 1024 * 8 })
    expect(sim.fluids.poolAt(3, 3, 3)).toBe(p)
  })
  it('rescans after replaceColumns on the next step', () => {
    const sim = fluidSim(lake(4))
    const empty = new Uint16Array(32 * 32 * 32)
    sim.replaceColumns([{ cx: 0, cz: 0, data: empty }])
    expect(sim.fluids.needsRebuild).toBe(true)
    sim.step()
    expect([sim.fluids.needsRebuild, sim.fluids.pools.count]).toEqual([false, 0])
  })
})
