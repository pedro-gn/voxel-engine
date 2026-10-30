import { describe, expect, it } from 'vitest'
import { BlockRegistry, defineBlock, type BlockDef } from '../src/blocks/registry.ts'
import { SPRING_RATES, SPRING_SCALE, SUB, UNIT } from '../src/sim/water/constants.ts'
import { defineGenerator } from '../src/sim/generator.ts'
import { Simulation } from '../src/sim/simulation.ts'
import { WaterColumns } from '../src/sim/water/columns.ts'
import { WaterCycle } from '../src/sim/water/cycle.ts'
import { UnderSegments } from '../src/sim/water/under.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { Layout } from '../src/world/layout.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, basin, fillGenerator, run, spring, waterSim, WATER_BLOCKS, type Fill } from './waterHelpers.ts'

/** WATER_BLOCKS with the spring given a head (same ids). */
const headed = (head: number): BlockDef[] => WATER_BLOCKS.map((d) => (d.name === 'spring' ? { ...d, head } : d))

/** A closed stone basin, 3 × 3 inside (x, z 1–3), walls to y 30; a spring (flow 0) on its floor at (2, 1, 2). */
const springBasin: Fill = (x, y, z) => (x === 2 && y === 1 && z === 2 ? spring(0) : basin(5, 30)(x, y, z))
/** The spring column's floor (the spring's top): a head of 2 rests its water's surface at 4 blocks. */
const SPRING_TOP = 2

describe('spring head', () => {
  it('spring with head 2 in a closed 3×3 stone basin stops at 2 blocks', () => {
    const sim = waterSim(springBasin, { blocks: headed(2) })
    // A still lake never rests flat in integers (constants.ts HEAD_EPS): the spring tops its column up to the head while the
    // lake still ripples, so the surface settles a few 1/SUB above it — under UNIT / 4, far below one mirror level.
    const near = (): void => {
      for (let z = 1; z <= 3; z++) for (let x = 1; x <= 3; x++) {
        const d = sim.water.column(x, z).surface - (SPRING_TOP + 2) * SUB
        expect(d >= 0 && d <= UNIT / 4, `column ${x},${z}: ${d}`).toBe(true)
      }
    }
    run(sim, 2000)
    near()
    const total = sim.water.cols.total()
    run(sim, 500)
    near()
    expect(sim.water.cols.total()).toBe(total) // the spring stopped
  })

  it('spring without head keeps filling', () => {
    const sim = waterSim(springBasin)
    run(sim, 2000)
    expect(sim.water.column(2, 2).surface).toBeGreaterThan(SPRING_TOP * SUB + 2 * SUB)
  })

  it('head-capped spring in an open channel still emits its full rate', () => {
    // A 1-wide channel along x at z = 5: the spring (flow 3) sits on stone at x = 1, y = 9; the floor steps down one block
    // per column to y = 2 at x = 8; x = 9 has no floor, so the water falls to the bottom of a void world and leaves.
    const FLOW = 3
    const fill: Fill = (x, y, z) => {
      if (x === 1 && z === 5) return y < 9 ? B.stone : y === 9 ? spring(FLOW) : AIR
      if (x >= 2 && x <= 8 && z === 5) return y < 10 - x ? B.stone : AIR
      if (x <= 8 && (z === 4 || z === 6 || x === 0) && z >= 4 && z <= 6 && y <= 12) return B.stone
      return AIR
    }
    const gen = defineGenerator({ ...fillGenerator(fill), configure: () => ({ void: true }) })
    const sim = new Simulation({
      buffers: createWorldBuffers([32, 32, 32]), blocks: headed(2), seed: 1, log: () => {}, randomTicksPerChunk: 0,
    })
    sim.configure(gen, null)
    sim.generate(gen)
    const rate = SPRING_RATES[FLOW]! * SPRING_SCALE
    run(sim, 400) // the channel reaches its steady flow
    // The spring takes what it emits from the sea account; the void's drain gives back what left the world.
    const cy = sim.water.cycle, runSprings = cy.runSprings.bind(cy)
    let emitted = 0
    cy.runSprings = (...a: Parameters<typeof runSprings>) => { const s = cy.sea; runSprings(...a); emitted += s - cy.sea }
    const sea0 = cy.sea
    run(sim, 100)
    const left = cy.sea - sea0 + emitted
    expect(emitted).toBe(rate * 100)
    expect(Math.abs(left - rate * 100)).toBeLessThanOrEqual(rate)
    expect(sim.water.column(1, 5).depth).toBeLessThan(2 * SUB)
  })

  it('caps a lower segment resting on the spring too', () => {
    const n = 32 * 32, c = 5 + 5 * 32, layout = new Layout([32, 32, 32])
    const cols = new WaterColumns(32, 32, new Int16Array(n))
    cols.floor.fill(20) // a roof: the spring (y 3) feeds a cave segment, floor 4, ceiling 10
    const under = new UnderSegments(n), low = under.alloc(c, 4, 10, 2 * SUB - 10)
    under.setChain(c, [low])
    const cy = new WaterCycle(n)
    cy.springs.add(layout.voxelIndex(5, 3, 5))
    const source = new Uint8Array(16), head = new Uint8Array(16)
    source[B.spring] = 1
    head[B.spring] = 2
    const get = (x: number, y: number, z: number): number => (x === 5 && y === 3 && z === 5 ? spring(4) : AIR)
    for (let i = 0; i < 3; i++) cy.runSprings(cols, under, layout, get, source, () => {}, head)
    expect([under.depth[low], cy.sea]).toEqual([2 * SUB, -10])
  })

  it('validates head: an integer 1–15 on a spring', () => {
    const water = defineBlock({ name: 'w', liquid: true })
    expect(new BlockRegistry([water, defineBlock({ name: 's', liquid: true, source: 'w', head: 15 })]).springHead[2]).toBe(15)
    expect(new BlockRegistry([water]).springHead[1]).toBe(0)
    for (const head of [0, 16, 1.5]) {
      expect(() => new BlockRegistry([water, defineBlock({ name: 's', liquid: true, source: 'w', head })])).toThrow(/head/)
    }
    expect(() => new BlockRegistry([defineBlock({ name: 'w', liquid: true, head: 2 })])).toThrow(/head/)
  })
})
