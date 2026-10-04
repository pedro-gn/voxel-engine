import { describe, expect, it, vi } from 'vitest'
import { SUB } from '../src/sim/water/constants.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, depthSum, fillGenerator, lake, run, settle, spring, surfaceSum, w, waterSim, type Fill } from './waterHelpers.ts'

/** lake(4): 10 × 10 columns, 4 blocks deep on a floor at y = 1. */
const LAKE = 100 * 4 * SUB

describe('water in the world', () => {
  it('rebuilds columns from the voxels at generation; a flat lake starts asleep', () => {
    const sim = waterSim(lake(4))
    expect(sim.water.column(5, 5)).toEqual({ floor: 1, depth: 4 * SUB, surface: 5 * SUB })
    expect(sim.water.column(0, 5)).toEqual({ floor: 9, depth: 0, surface: 9 * SUB })
    expect(sim.water.column(20, 20)).toEqual({ floor: 1, depth: 0, surface: SUB })
    expect(sim.water.total()).toBe(LAKE)
    expect(sim.water.expected).toBe(LAKE)
    expect(sim.step().physics).toMatchObject({ waterTiles: 0, waterColumns: 0, busy: false })
  })

  it('a wall landing on the lake floor raises the surface by its volume: sand sinks through the water', () => {
    const sim = waterSim(lake(4))
    const s0 = surfaceSum(sim, 1, 1, 10, 10)
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 8, 5], voxel: B.sand })
    settle(sim)
    expect(sim.store.getVoxel(5, 1, 5)).toBe(B.sand)
    expect(sim.water.column(5, 5).floor).toBe(2)
    expect(surfaceSum(sim, 1, 1, 10, 10) - s0).toBe(SUB)
    expect(sim.water.total()).toBe(LAKE)
  })

  it('a wall dropped into the water pushes the water trapped under it up', () => {
    const sim = waterSim(lake(4))
    const s0 = surfaceSum(sim, 1, 1, 10, 10)
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 2, 5], voxel: B.stone })
    sim.step()
    expect(sim.water.column(5, 5).floor).toBe(3)
    expect(sim.store.getVoxel(5, 1, 5)).toBe(AIR) // the pocket under the wall emptied
    expect(surfaceSum(sim, 1, 1, 10, 10) - s0).toBe(2 * SUB)
    expect(sim.water.total()).toBe(LAKE)
  })

  it('digging out a floor drops it to the next wall, and static water on the way joins the column', () => {
    const sim = waterSim((x, y, z) => (y < 12 ? (x === 5 && z === 5 && y === 3 ? w(7) : B.stone) : AIR))
    expect(sim.water.column(5, 5)).toMatchObject({ floor: 12, depth: 0 }) // the cave cell is static
    sim.submit(0, 0, { type: 'fillRegion', min: [5, 4, 5], max: [5, 11, 5], voxel: AIR })
    sim.step()
    expect(sim.water.column(5, 5)).toMatchObject({ floor: 3, depth: SUB })
    expect(sim.water.total()).toBe(SUB)
    expect(sim.water.expected).toBe(SUB)
  })

  it('water placed in the air over a lake joins its column: the voxel goes and the surface rises', () => {
    const sim = waterSim(lake(4))
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 7, 5], voxel: w(7) })
    sim.step()
    expect(sim.store.getVoxel(5, 7, 5)).toBe(AIR)
    expect(sim.water.total()).toBe(LAKE + SUB)
    expect(sim.water.expected).toBe(LAKE + SUB)
    settle(sim)
    expect(Math.abs(sim.water.column(5, 5).surface - (5 * SUB + SUB / 100))).toBeLessThanOrEqual(16)
  })

  it('water removed by a command leaves its column', () => {
    const sim = waterSim(lake(4))
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 4, 5], voxel: AIR })
    sim.step()
    expect(sim.water.total()).toBe(LAKE - SUB)
    expect(sim.water.expected).toBe(LAKE - SUB)
  })

  it('a block above the surface is a bridge: the floor stays, rising water never overwrites it, and removing it lets water in', () => {
    const sim = waterSim(lake(4, 12, 12))
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 6, 5], voxel: B.stone })
    sim.step()
    expect(sim.water.column(5, 5).floor).toBe(1)
    sim.submit(0, 1, { type: 'fillRegion', min: [1, 9, 1], max: [10, 11, 10], voxel: w(7) }) // 3 more blocks over the lake
    settle(sim)
    expect(sim.store.getVoxel(5, 6, 5)).toBe(B.stone)
    expect(sim.store.getVoxel(5, 5, 5) & 0xfff).toBe(B.water)
    expect(sim.store.getVoxel(5, 7, 5) & 0xfff).toBe(B.water)
    sim.submit(0, 2, { type: 'setBlock', pos: [5, 6, 5], voxel: AIR })
    sim.step()
    expect(sim.store.getVoxel(5, 6, 5) & 0xfff).toBe(B.water)
    expect(sim.water.total()).toBe(sim.water.expected)
  })

  it('an edit on dry land far from water wakes no tile', () => {
    const sim = waterSim(lake(4))
    sim.submit(0, 0, { type: 'setBlock', pos: [25, 1, 25], voxel: B.stone })
    const r = sim.step()
    expect(sim.water.column(25, 25).floor).toBe(2)
    expect(r.physics.waterTiles).toBe(0)
  })

  it('a spring on its column\'s floor runs from the sea, and Σ depth + sea holds', () => {
    // Sea (level 3) for z ≥ 24; land at floor 5 elsewhere, with a spring on it.
    const coast: Fill = (x, y, z) => {
      if (y === 0) return B.stone
      if (z >= 24) return y <= 2 ? w(7) : AIR
      if (y <= 4) return B.stone
      return x === 5 && z === 5 && y === 5 ? spring(5) : AIR
    }
    const sim = waterSim(coast, { seaLevel: 3 })
    expect(sim.water.cycle.springs.size).toBe(1)
    expect(sim.water.sea).toBe(8 * 32 * 2 * SUB)
    const t0 = sim.water.total()
    run(sim, 200)
    expect(sim.water.total()).toBe(t0)
    expect(sim.water.sea).toBeLessThan(8 * 32 * 2 * SUB)
    expect(depthSum(sim, 0, 0, 31, 23)).toBeGreaterThan(0)
  })

  it('a spring gives nothing when the world has a sea level but no sea', () => {
    const sim = waterSim((x, y, z) => (y <= 4 ? B.stone : x === 5 && z === 5 && y === 5 ? spring(5) : AIR), { seaLevel: 3 })
    run(sim, 50)
    expect(sim.water.total()).toBe(0)
    expect(sim.water.sea).toBe(0)
  })

  it('a channel dug beside a lake fills while the lake goes down by exactly what it holds', () => {
    // A 10 × 10 lake 4 deep in a pit (floor 1, ground at 7 around it); the channel runs east from it.
    const pit: Fill = (x, y, z) => {
      if (y === 0) return B.stone
      if (x >= 1 && x <= 10 && z >= 1 && z <= 10) return y <= 4 ? w(7) : AIR
      return y <= 6 ? B.stone : AIR
    }
    const sim = waterSim(pit)
    const lake0 = depthSum(sim, 1, 1, 10, 10)
    sim.submit(0, 0, { type: 'fillRegion', min: [11, 1, 5], max: [20, 6, 6], voxel: AIR })
    settle(sim)
    const channel = depthSum(sim, 11, 5, 20, 6)
    expect(channel).toBeGreaterThan(20 * 3 * SUB)
    expect(lake0 - depthSum(sim, 1, 1, 10, 10)).toBe(channel)
  })
})

describe('water in the world: edits and rebuilds', () => {
  it('hotbar water placed in mid-air over dry ground falls into its column: the voxel is gone after the tick', () => {
    const sim = waterSim(lake(4))
    sim.submit(0, 0, { type: 'setBlock', pos: [25, 10, 25], voxel: w(7) })
    sim.step()
    expect(sim.store.getVoxel(25, 10, 25)).toBe(AIR)
    expect(sim.store.getVoxel(25, 1, 25) & 0xfff).toBe(B.water)
    expect(sim.water.total()).toBe(LAKE + SUB)
    expect(sim.water.expected).toBe(LAKE + SUB)
    for (let y = 2; y < 32; y++) expect(sim.store.getVoxel(25, y, 25)).toBe(AIR)
  })

  it('hotbar water placed on a lake raises the lake by exactly its volume and never stays a floating cell', () => {
    const sim = waterSim(lake(4))
    const s0 = surfaceSum(sim, 1, 1, 10, 10)
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 5, 5], voxel: w(3) }) // half a block on the surface
    sim.step()
    expect(sim.water.total()).toBe(LAKE + SUB / 2)
    settle(sim)
    expect(surfaceSum(sim, 1, 1, 10, 10) - s0).toBe(SUB / 2)
    for (let z = 1; z <= 10; z++) for (let x = 1; x <= 10; x++) expect(sim.store.getVoxel(x, 6, z)).toBe(AIR)
  })

  it('a wall placed in water and removed in the same tick creates no water: the trapped cells are cleared at once', () => {
    const sim = waterSim(lake(4))
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 3, 5], voxel: B.stone })
    sim.submit(0, 1, { type: 'setBlock', pos: [5, 3, 5], voxel: AIR })
    sim.step()
    expect(sim.water.column(5, 5).floor).toBe(1)
    expect(sim.water.expected).toBe(LAKE)
    expect(sim.water.total()).toBe(LAKE)
    settle(sim)
    expect(sim.water.total()).toBe(LAKE)
    expect(sim.water.check()).toEqual([])
  })

  it('removing a wall beside a lake lets the water into the gap', () => {
    const sim = waterSim(lake(4))
    sim.submit(0, 0, { type: 'fillRegion', min: [0, 1, 5], max: [0, 8, 5], voxel: AIR }) // a notch in the west wall
    settle(sim)
    expect(sim.water.column(0, 5).floor).toBe(1)
    expect(sim.water.column(0, 5).depth).toBeGreaterThan(0)
    expect(sim.store.getVoxel(0, 1, 5) & 0xfff).toBe(B.water)
    expect(sim.water.total()).toBe(LAKE)
  })

  it('water hovering over air at generation is not a floating column: it rests on the next wall below', () => {
    const sim = waterSim((x, y, z) => (y === 0 ? B.stone : x === 20 && z === 20 && (y === 10 || y === 11) ? w(7) : AIR))
    expect(sim.water.column(20, 20)).toMatchObject({ floor: 1, depth: 2 * SUB })
    expect(sim.water.total()).toBe(2 * SUB)
    sim.step()
    expect(sim.store.getVoxel(20, 10, 20)).toBe(AIR)
    expect(sim.store.getVoxel(20, 11, 20)).toBe(AIR)
    expect(sim.store.getVoxel(20, 1, 20) & 0xfff).toBe(B.water)
    expect(sim.water.total()).toBe(sim.water.expected)
  })

  it('a floor dug out over static water remeshes the chunk that water is in, even with no write there', () => {
    // Static water 25..31 (chunk y 0) under a thick glass roof 33..40 (chunk y 1); glass lets the sky through, so no light changes.
    const sim = waterSim((x, y, z) => {
      if (y < 25) return B.stone
      if (y <= 31) return x === 5 && z === 5 ? w(7) : B.stone
      if (y === 32) return x === 5 && z === 5 ? AIR : B.stone
      return y <= 40 && x === 5 && z === 5 ? B.glass : AIR
    }, { size: [32, 64, 32] })
    expect(sim.water.column(5, 5)).toMatchObject({ floor: 41, depth: 0 })
    const spy = vi.spyOn(sim.store, 'markDirty')
    sim.submit(0, 0, { type: 'fillRegion', min: [5, 33, 5], max: [5, 40, 5], voxel: AIR })
    const r = sim.step()
    expect(sim.water.column(5, 5)).toMatchObject({ floor: 25, depth: 7 * SUB })
    const low = sim.layout.chunkIndex(0, 0, 0)
    expect(spy).toHaveBeenCalledWith(low)
    expect(r.dirtyChunks).toContain(low)
  })

  it('a regenerated region remeshes the chunks whose static water became the heightfield\'s', () => {
    const roofed: Fill = (x, y, z) => {
      if (y < 25) return B.stone
      if (y <= 31) return x === 5 && z === 5 ? w(7) : B.stone
      if (y === 32) return x === 5 && z === 5 ? AIR : B.stone
      return y <= 40 && x === 5 && z === 5 ? B.glass : AIR
    }
    const open: Fill = (x, y, z) => (y > 32 && x === 5 && z === 5 ? AIR : roofed(x, y, z))
    const sim = waterSim(roofed, { size: [32, 64, 32] })
    const data = new Uint16Array(32 * 32 * 64)
    sim.generateColumnData(fillGenerator(open), 0, 0, data)
    const out = sim.replaceColumns([{ cx: 0, cz: 0, data }])
    expect(sim.water.column(5, 5)).toMatchObject({ floor: 25, depth: 7 * SUB })
    expect(out).toContain(sim.layout.chunkIndex(0, 0, 0))
    expect(sim.water.total()).toBe(sim.water.expected)
  })

  it('a region rebuild adds the depth of columns that join the sea to the sea account, and removes it when they leave', () => {
    // 64 × 32 × 32: chunk column 1 (x ≥ 32) is sea at level 3; chunk column 0 is land at floor 5, or sea when `wet`.
    const coast = (wet: boolean): Fill => (x, y) => {
      if (y === 0) return B.stone
      if (x >= 32 || wet) return y <= 2 ? w(7) : AIR
      return y <= 4 ? B.stone : AIR
    }
    const sim = waterSim(coast(false), { seaLevel: 3, size: [64, 32, 32] })
    const half = 32 * 32 * 2 * SUB
    expect(sim.water.sea).toBe(half)
    const data = new Uint16Array(32 * 32 * 32)
    sim.generateColumnData(fillGenerator(coast(true)), 0, 0, data)
    sim.replaceColumns([{ cx: 0, cz: 0, data }])
    expect(sim.water.cycle.mask[5 + 5 * 64]).toBe(1)
    expect(sim.water.sea).toBe(2 * half)
    expect(sim.water.total()).toBe(sim.water.expected)
    sim.generateColumnData(fillGenerator(coast(false)), 0, 0, data)
    sim.replaceColumns([{ cx: 0, cz: 0, data }])
    expect(sim.water.cycle.mask[5 + 5 * 64]).toBe(0)
    expect(sim.water.sea).toBe(half)
    expect(sim.water.total()).toBe(sim.water.expected)
    run(sim, 20)
    expect(sim.water.total()).toBe(sim.water.expected)
  })

  it('springs placed and removed by commands: the spring set, the wake-ups and the sea mask follow', () => {
    // Sea (level 3) for z ≥ 24, land at floor 5 elsewhere.
    const coast: Fill = (_x, y, z) => {
      if (y === 0) return B.stone
      if (z >= 24) return y <= 2 ? w(7) : AIR
      return y <= 4 ? B.stone : AIR
    }
    const sim = waterSim(coast, { seaLevel: 3 })
    expect(sim.water.cycle.springs.size).toBe(0)
    const sea0 = sim.water.sea
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 5, 5], voxel: spring(5) })
    const r = sim.step()
    expect(sim.water.cycle.springs.size).toBe(1)
    expect(sim.water.column(5, 5).floor).toBe(6)
    expect(r.physics.waterTiles).toBeGreaterThan(0) // the spring's tile woke and steps
    expect(sim.water.sea).toBeLessThan(sea0)
    expect(depthSum(sim, 4, 4, 6, 6)).toBe(sea0 - sim.water.sea) // what it gave poured off its block onto the ground around
    run(sim, 20)
    expect(sim.water.total()).toBe(sim.water.expected)
    // A block on top buries it: it gives nothing until the block is removed again.
    sim.submit(0, 1, { type: 'setBlock', pos: [5, 6, 5], voxel: B.stone })
    sim.step()
    const buried = sim.water.sea
    run(sim, 5)
    expect(sim.water.sea).toBe(buried)
    sim.submit(0, 2, { type: 'setBlock', pos: [5, 6, 5], voxel: AIR })
    run(sim, 3)
    expect(sim.water.sea).toBeLessThan(buried)
    // Removed by a command: forgotten, and it gives nothing more.
    sim.submit(0, 3, { type: 'setBlock', pos: [5, 5, 5], voxel: B.stone })
    sim.step()
    expect(sim.water.cycle.springs.size).toBe(0)
    const sea = sim.water.sea
    run(sim, 5)
    expect(sim.water.sea).toBe(sea)
    // A pillar in the sea that rises to the sea level leaves the sea mask; the sea columns around stay in it.
    sim.submit(0, 4, { type: 'fillRegion', min: [10, 1, 28], max: [10, 3, 28], voxel: B.stone })
    sim.step()
    expect(sim.water.cycle.mask[10 + 28 * 32]).toBe(0)
    expect(sim.water.cycle.mask[11 + 28 * 32]).toBe(1)
    run(sim, 50)
    expect(sim.water.total()).toBe(sim.water.expected)
    expect(sim.water.check()).toEqual([])
  })

  it('a wall at the world\'s top row sets the floor to the world height without reading or writing out of bounds', () => {
    const sim = waterSim(lake(4), { water: { debug: true } })
    sim.submit(0, 0, { type: 'fillRegion', min: [3, 1, 3], max: [3, 31, 3], voxel: B.stone }) // a pillar through the lake to the top
    sim.submit(0, 1, { type: 'fillRegion', min: [25, 1, 25], max: [25, 30, 25], voxel: B.stone }) // a dry pillar…
    sim.submit(0, 2, { type: 'setBlock', pos: [25, 31, 25], voxel: B.stone }) // …capped at the top row
    expect(() => run(sim, 3)).not.toThrow()
    expect(sim.water.column(3, 3).floor).toBe(32)
    expect(sim.water.column(25, 25).floor).toBe(32)
    expect(() => settle(sim)).not.toThrow()
    expect(sim.water.total()).toBe(LAKE)
    expect(sim.water.check()).toEqual([])
    // Water placed on the pillar's top joins its column at the world's ceiling, then pours off it.
    sim.submit(0, 3, { type: 'setBlock', pos: [3, 31, 3], voxel: AIR })
    sim.submit(0, 4, { type: 'setBlock', pos: [3, 31, 3], voxel: w(7) })
    expect(() => settle(sim)).not.toThrow()
    expect(sim.water.total()).toBe(sim.water.expected)
    expect(sim.water.check()).toEqual([])
  })
})
