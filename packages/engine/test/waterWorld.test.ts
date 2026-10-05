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
    const logs: string[] = []
    const sim = waterSim(coast, { seaLevel: 3, water: { debug: true }, log: (m) => logs.push(m) })
    expect(sim.water.cycle.springs.size).toBe(1)
    expect(sim.water.sea).toBe(8 * 32 * 2 * SUB)
    const t0 = sim.water.total()
    let off = 0
    for (let t = 0; t < 200; t++) { sim.step(); if (sim.water.total() !== t0) off++ }
    expect(off).toBe(0)
    expect(logs).toEqual([])
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
    expect(sim.water.expected).toBe(0) // the cave water is static: not the heightfield's
    const out = sim.replaceColumns([{ cx: 0, cz: 0, data }])
    expect(sim.water.column(5, 5)).toMatchObject({ floor: 25, depth: 7 * SUB })
    expect(out).toContain(sim.layout.chunkIndex(0, 0, 0))
    expect(sim.water.expected).toBe(7 * SUB) // it joined the heightfield's running total
  })

  it('a healing rebuild remeshes the chunks whose static water became the heightfield\'s', () => {
    const sim = waterSim((x, y, z) => {
      if (y < 25) return B.stone
      if (y <= 31) return x === 5 && z === 5 ? w(7) : B.stone
      if (y === 32) return x === 5 && z === 5 ? AIR : B.stone
      return y <= 40 && x === 5 && z === 5 ? B.glass : AIR
    }, { size: [32, 64, 32] })
    expect(sim.water.column(5, 5)).toMatchObject({ floor: 41, depth: 0 })
    // The roof goes behind the water system's back (as after a physics error), and the next step heals from the voxels.
    for (let y = 33; y <= 40; y++) sim.store.setVoxelQuiet(5, y, 5, AIR)
    sim.water.needsRebuild = true
    const r = sim.step()
    expect(sim.water.column(5, 5)).toMatchObject({ floor: 25, depth: 7 * SUB })
    expect(r.dirtyChunks).toContain(sim.layout.chunkIndex(0, 0, 0))
  })

  it('a regeneration rebuilds only the regenerated chunk columns: one between two of them keeps its flow', () => {
    // 96 × 32 × 32: chunk column 1 holds walled water that is still flowing (a mound in a pool); 0 and 2 are dry land.
    const pool = (extra: boolean): Fill => (x, y, z) => {
      if (y === 0) return B.stone
      if (extra && (x === 5 || x === 70) && y <= 10 && z === 5) return B.stone // the regenerations' change: dry pillars
      if (x < 32 || x >= 64) return AIR
      if (x === 32 || x === 63 || z === 0 || z === 31) return y <= 8 ? B.stone : AIR
      return y <= (x >= 40 && x <= 50 && z >= 10 && z <= 20 ? 6 : 2) ? w(7) : AIR
    }
    const sim = waterSim(pool(false), { size: [96, 32, 32] })
    run(sim, 5)
    const sx = 96, cols = sim.water.cols
    const snap = () => {
      const out: number[] = []
      for (let z = 0; z < 32; z++) for (let x = 33; x < 63; x++) {
        const c = x + z * sx
        out.push(cols.depth[c]!, cols.flux[2 * c + 1]!, x < 62 ? cols.flux[2 * c]! : 0)
      }
      return out
    }
    const before = snap()
    expect(before.some((v, i) => i % 3 !== 0 && v !== 0)).toBe(true) // it is flowing
    const data0 = new Uint16Array(32 * 32 * 32), data2 = new Uint16Array(32 * 32 * 32)
    sim.generateColumnData(fillGenerator(pool(true)), 0, 0, data0)
    sim.generateColumnData(fillGenerator(pool(true)), 2, 0, data2)
    sim.replaceColumns([{ cx: 0, cz: 0, data: data0 }, { cx: 2, cz: 0, data: data2 }])
    expect(snap()).toEqual(before)
    expect(sim.water.column(5, 5).floor).toBe(11) // the regenerated columns were rebuilt
    expect(sim.water.column(70, 5).floor).toBe(11)
    run(sim, 20)
    expect(sim.water.total()).toBe(sim.water.expected)
  })

  it('a new sea level from configure() finds the sea again at once', () => {
    // Water 2 blocks deep (surface 3) over the whole 32 × 32 floor: the sea at level 3.
    const flat: Fill = (_x, y) => (y === 0 ? B.stone : y <= 2 ? w(7) : AIR)
    const sim = waterSim(flat, { seaLevel: 3 })
    expect(sim.water.cycle.mask[5 + 5 * 32]).toBe(1)
    sim.configure(fillGenerator(flat, 5), null) // the same water is no sea at level 5…
    expect(sim.water.cycle.mask[5 + 5 * 32]).toBe(0)
    run(sim, 5)
    expect(sim.water.column(5, 5)).toMatchObject({ floor: 1, depth: 2 * SUB }) // …so nothing pins it to 5
    expect(sim.water.total()).toBe(sim.water.expected)
    sim.configure(fillGenerator(flat, 3), null) // back at level 3 it is the sea again
    expect(sim.water.cycle.mask[5 + 5 * 32]).toBe(1)
    run(sim, 5)
    expect(sim.water.column(5, 5)).toMatchObject({ floor: 1, depth: 2 * SUB })
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
    const e0 = sim.water.expected
    sim.generateColumnData(fillGenerator(coast(true)), 0, 0, data)
    sim.replaceColumns([{ cx: 0, cz: 0, data }])
    expect(sim.water.cycle.mask[5 + 5 * 64]).toBe(1)
    expect(sim.water.sea).toBe(2 * half)
    expect(sim.water.expected - e0).toBe(2 * half) // the new sea's water, in the columns and in the account
    sim.generateColumnData(fillGenerator(coast(false)), 0, 0, data)
    sim.replaceColumns([{ cx: 0, cz: 0, data }])
    expect(sim.water.cycle.mask[5 + 5 * 64]).toBe(0)
    expect(sim.water.sea).toBe(half)
    expect(sim.water.expected).toBe(e0)
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

  it('filling the gap under a floating block merges them into the floor: water never crosses the dam', () => {
    // A lake (x 1–8, z 1–10, surface 3.5) dammed on the east at x = 9 by stone at y = 1, 3 and 4 with a gap at y = 2.
    const dammed: Fill = (x, y, z) => {
      if (y === 0) return B.stone
      if (x <= 9 && (x === 0 || z === 0 || z === 11) && z <= 11) return y <= 8 ? B.stone : AIR
      if (x === 9 && z <= 10) return y === 1 || y === 3 || y === 4 ? B.stone : AIR
      if (x >= 1 && x <= 8 && z >= 1 && z <= 10) return y <= 2 ? w(7) : y === 3 ? w(3) : AIR
      return AIR
    }
    const sim = waterSim(dammed, { water: { debug: true } })
    expect(sim.water.column(9, 5)).toMatchObject({ floor: 2, depth: 0 }) // the gap: the block over it floats
    const lake0 = sim.water.total()
    sim.submit(0, 0, { type: 'fillRegion', min: [9, 2, 1], max: [9, 2, 10], voxel: B.stone }) // filled before any step
    sim.step()
    for (let z = 1; z <= 10; z++) expect(sim.water.column(9, z).floor).toBe(5)
    run(sim, 600)
    expect(depthSum(sim, 9, 0, 31, 31)).toBe(0)
    for (let y = 1; y < 8; y++) for (let z = 0; z < 32; z++) for (let x = 10; x < 32; x++) expect(sim.store.getVoxel(x, y, z)).toBe(AIR)
    expect(sim.water.total()).toBe(lake0)
    // The edited floors are what a rebuild from the same voxels finds.
    const floors = Array.from({ length: 10 }, (_, i) => sim.water.column(9, i + 1).floor)
    sim.water.rebuild()
    expect(Array.from({ length: 10 }, (_, i) => sim.water.column(9, i + 1).floor)).toEqual(floors)
    expect(sim.water.total()).toBe(lake0)
  })

  it('while paused, edits change the columns exactly and show through the mirror; nothing flows, and resuming loses no water', () => {
    const sim = waterSim(lake(4), { water: { debug: true } })
    sim.setPaused(true)
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 2, 5], voxel: B.stone }) // a wall in the water
    sim.submit(0, 1, { type: 'setBlock', pos: [25, 10, 25], voxel: w(7) }) // water in the air over dry ground
    sim.submit(0, 2, { type: 'setBlock', pos: [8, 4, 8], voxel: AIR }) // a water cell taken out, outside the spread
    sim.step()
    // the wall displaced 2 blocks of water: 32 columns around take 1/16 block each, the wall's own column too
    expect(sim.water.column(5, 5)).toMatchObject({ floor: 3, depth: 2 * SUB + SUB / 16, surface: 5 * SUB + SUB / 16 })
    expect(sim.water.column(25, 25)).toMatchObject({ floor: 1, depth: SUB })
    expect(sim.water.column(8, 8)).toMatchObject({ floor: 1, depth: 3 * SUB })
    expect(sim.water.expected).toBe(LAKE)
    // The mirror follows while paused: the pocket under the wall is empty, the column over it stands as high as the lake, the
    // placed cell lies on the ground, and above the lake nothing is left.
    expect(sim.store.getVoxel(5, 1, 5)).toBe(AIR)
    expect(sim.store.getVoxel(5, 4, 5) & 0xfff).toBe(B.water)
    expect(sim.store.getVoxel(25, 10, 25)).toBe(AIR)
    expect(sim.store.getVoxel(25, 1, 25) & 0xfff).toBe(B.water)
    expect(sim.store.getVoxel(8, 4, 8)).toBe(AIR)
    expect(sim.store.getVoxel(8, 3, 8) & 0xfff).toBe(B.water)
    const steps = sim.water.stepCount
    run(sim, 20)
    expect(sim.water.stepCount).toBe(steps)
    expect(sim.water.column(25, 25).depth).toBe(SUB)
    expect(sim.water.column(26, 25).depth).toBe(0)
    sim.setPaused(false)
    settle(sim)
    expect(sim.water.needsRebuild).toBe(false)
    expect(sim.water.total()).toBe(LAKE)
    expect(sim.water.check()).toEqual([])
  })
})

describe('a block placed in water spreads its displaced volume at once', () => {
  const big = (top: number) => lake(top, 22, 8) // 20 × 20 columns, floor y = 1

  /** The largest surface difference between two neighbouring wet columns of the 20 × 20 lake. */
  function maxStep(sim: ReturnType<typeof waterSim>): number {
    let m = 0
    for (let z = 1; z <= 20; z++) for (let x = 1; x <= 20; x++) {
      const s = sim.water.column(x, z).surface
      if (x < 20) m = Math.max(m, Math.abs(s - sim.water.column(x + 1, z).surface))
      if (z < 20) m = Math.max(m, Math.abs(s - sim.water.column(x, z + 1).surface))
    }
    return m
  }

  it('a block on the floor of a lake leaves no pillar: no column is more than 1/16 block above a neighbour, volume exact', () => {
    const sim = waterSim(big(4), { water: { debug: true } })
    const total = sim.water.total()
    sim.submit(0, 0, { type: 'setBlock', pos: [10, 1, 10], voxel: B.stone })
    sim.step()
    expect(sim.water.column(10, 10).floor).toBe(2)
    expect(maxStep(sim)).toBeLessThanOrEqual(SUB / 16)
    expect(sim.water.total()).toBe(total)
    expect(sim.water.expected).toBe(total)
    expect(sim.water.check()).toEqual([])
    settle(sim)
    expect(sim.water.total()).toBe(total)
  })

  it('a block floating in the water pushes only the trapped water, and that spreads too', () => {
    const sim = waterSim(big(4), { water: { debug: true } })
    const total = sim.water.total()
    sim.submit(0, 0, { type: 'setBlock', pos: [10, 3, 10], voxel: B.stone })
    sim.step()
    expect(sim.water.column(10, 10).floor).toBe(4)
    expect(maxStep(sim)).toBeLessThanOrEqual(SUB / 16)
    expect(sim.water.total()).toBe(total)
    expect(sim.water.check()).toEqual([])
  })

  it('a block in a one-column hole keeps the old behaviour: the water rides on top', () => {
    // stone to y = 6 with a single hole at (5, 5): water at y 1..4, the rim above it
    const sim = waterSim((x, y, z) => (y <= 6 && !(x === 5 && z === 5 && y >= 1) ? B.stone : y >= 1 && y <= 4 && x === 5 && z === 5 ? w(7) : AIR))
    expect(sim.water.column(5, 5)).toMatchObject({ floor: 1, depth: 4 * SUB })
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 1, 5], voxel: B.stone })
    sim.step()
    expect(sim.water.column(5, 5)).toEqual({ floor: 2, depth: 4 * SUB, surface: 6 * SUB })
  })

  it('is deterministic: the same edit gives the same state hash', () => {
    const hash = () => {
      const sim = waterSim(big(4))
      sim.submit(0, 0, { type: 'setBlock', pos: [10, 1, 10], voxel: B.stone })
      sim.submit(0, 0, { type: 'setBlock', pos: [3, 2, 4], voxel: B.stone })
      run(sim, 40)
      let h = 17
      sim.water.mixState((v) => { h = (Math.imul(h, 31) + v) | 0 })
      return h
    }
    expect(hash()).toBe(hash())
  })

  it('a whole command spreads once: a 6 × 6 × 2 block on the floor lifts the lake evenly, volume exact', () => {
    const sim = waterSim(big(4), { water: { debug: true } })
    const total = sim.water.total()
    sim.submit(0, 0, { type: 'fillRegion', min: [8, 1, 8], max: [13, 2, 13], voxel: B.stone })
    sim.step()
    expect(sim.water.total()).toBe(total)
    expect(sim.water.check()).toEqual([])
    // 36 columns × 2 blocks displaced over all 400 columns of the lake (fewer than wanted): 46 or 47 each
    for (let z = 1; z <= 20; z++) for (let x = 1; x <= 20; x++) {
      if (x >= 8 && x <= 13 && z >= 8 && z <= 13) continue
      const d = sim.water.column(x, z).depth - 4 * SUB
      expect(d === 46 || d === 47).toBe(true)
    }
  })

  it('skips a wet neighbour on a higher step: its floor is at or above the source surface', () => {
    const base = lake(4, 13, 8)
    const sim = waterSim((x, y, z) => (x === 11 && z > 0 && z < 12 && y >= 1 ? (y <= 5 ? B.stone : y <= 7 ? w(7) : AIR) : base(x, y, z)))
    sim.setPaused(true) // no physics: only the spread moves water
    expect(sim.water.column(11, 5)).toMatchObject({ floor: 6, depth: 2 * SUB })
    const total = sim.water.total()
    sim.submit(0, 0, { type: 'setBlock', pos: [10, 1, 5], voxel: B.stone })
    sim.step()
    expect(sim.water.column(11, 5).depth).toBe(2 * SUB)
    expect(sim.water.column(10, 5).floor).toBe(2)
    expect(sim.water.total()).toBe(total)
  })

  it('a sea column can take a share: the pin credits it back to the sea and the account stays exact', () => {
    const sim = waterSim((x, y) => (y === 0 ? B.stone : y <= 3 ? w(7) : AIR), { seaLevel: 4, water: { debug: true } })
    const total = sim.water.total()
    sim.submit(0, 0, { type: 'setBlock', pos: [16, 1, 16], voxel: B.stone })
    run(sim, 30)
    expect(sim.water.total()).toBe(total)
    expect(sim.water.check()).toEqual([])
    expect(sim.water.column(15, 16).depth).toBe(3 * SUB) // pinned to the sea level again
  })

  it('works at the world border', () => {
    const sim = waterSim((x, y) => (y === 0 ? B.stone : y <= 3 ? w(7) : AIR), { water: { debug: true } })
    const total = sim.water.total()
    sim.submit(0, 0, { type: 'setBlock', pos: [0, 1, 0], voxel: B.stone })
    sim.step()
    expect(sim.water.column(0, 0).floor).toBe(2)
    expect(sim.water.total()).toBe(total)
    expect(sim.water.check()).toEqual([])
    expect(sim.water.column(1, 0).depth).toBeGreaterThan(3 * SUB)
  })

  it('a volume too big for the radius is still spread exactly (shares exceed 1/16 block, normal flow levels it)', () => {
    const sim = waterSim(lake(24, 128, 30), { size: [128, 32, 128], water: { debug: true } })
    const total = sim.water.total()
    sim.submit(0, 0, { type: 'fillRegion', min: [40, 23, 40], max: [79, 23, 79], voxel: B.stone })
    sim.step()
    expect(sim.water.total()).toBe(total)
    expect(sim.water.check()).toEqual([])
    expect(sim.water.column(35, 60).depth).toBeGreaterThan(24 * SUB)
    expect(sim.water.column(1, 1).depth).toBe(24 * SUB) // far outside the radius: untouched
  })
})
