import { defineBlock, type BlockDef } from '../src/blocks/registry.ts'
import type { FluidOptions } from '../src/sim/fluids/fluidSystem.ts'
import { defineGenerator } from '../src/sim/generator.ts'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { AIR, packVoxel } from '../src/world/voxel.ts'
import { TEST_BLOCKS } from './helpers.ts'

export const FLUID_BLOCKS: BlockDef[] = [
  ...TEST_BLOCKS,
  defineBlock({ name: 'sand', falls: true }),
  defineBlock({ name: 'spring', liquid: true, source: 'water', textures: 'water' }),
]
export const B = { air: 0, stone: 1, dirt: 2, grass: 3, glass: 4, water: 5, torch: 6, leaves: 7, sand: 8, spring: 9 } as const
/** A water voxel at a level (0–7). */
export const w = (level = 7): number => packVoxel(B.water, level)
export const spring = (flow = 5): number => packVoxel(B.spring, flow)

export type Fill = (x: number, y: number, z: number) => number
export interface FluidSimOptions {
  size?: [number, number, number]
  /** Handed to the sim through the generator's configure(); springs then draw from the pool at seaLevel − 1. */
  seaLevel?: number
  seed?: number
  fluids?: Partial<FluidOptions>
  jobCap?: number
  /** Replaces FLUID_BLOCKS (extend it to add liquids). */
  blocks?: BlockDef[]
}

/** A Simulation generated from `fill`. Fluids step every tick unless `fluids.fluidEvery` says otherwise. */
export function fluidSim(fill: Fill, o: FluidSimOptions = {}): Simulation {
  const size = o.size ?? [32, 32, 32]
  const sim = new Simulation({
    buffers: createWorldBuffers(size), blocks: o.blocks ?? FLUID_BLOCKS, seed: o.seed ?? 1, log: () => {},
    fluids: { fluidEvery: 1, ...o.fluids }, jobCap: o.jobCap,
  })
  const gen = defineGenerator({
    configure: () => (o.seaLevel === undefined ? undefined : { seaLevel: o.seaLevel }),
    generateColumn(ctx, cx, cz) {
      for (let y = 0; y < ctx.height; y++) for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
        const v = fill(cx * 32 + lx, y, cz * 32 + lz)
        if (v !== AIR) ctx.column[lx + (lz << 5) + (y << 10)] = v
      }
    },
  })
  sim.configure(gen, null)
  sim.generate(gen)
  return sim
}

export function run(sim: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) sim.step()
}

/** Steps until no cell is active and no region job is queued; returns the ticks it took. Throws after `max`. */
export function settle(sim: Simulation, max = 3000): number {
  for (let i = 0; i < max; i++) {
    if (sim.fluids.activeCount === 0 && sim.jobs.size === 0) return i
    sim.step()
  }
  throw new Error(`fluids still moving after ${max} ticks (${sim.fluids.activeCount} active, ${sim.jobs.size} jobs)`)
}

/** Exact liquid in the world: cells + pool balances + lost. */
export const volume = (sim: Simulation): number => sim.fluids.totalVolume()

/** A stone box: floor y < 1, walls at x/z = 0 and side − 1 up to `wallTop`, air inside. */
export function basin(side: number, wallTop: number): Fill {
  return (x, y, z) => {
    if (y === 0) return B.stone
    if ((x === 0 || z === 0 || x === side - 1 || z === side - 1) && y <= wallTop && x < side && z < side) return B.stone
    return AIR
  }
}

/** Every pool-invariant violation in the world (see FluidSystem.checkInvariants); [] when consistent. */
export const poolProblems = (sim: Simulation): string[] => sim.fluids.checkInvariants()

/** A basin of side 12 (walls to y = 8) holding full water for 1 ≤ y ≤ top. */
export function lake(top: number, side = 12, wallTop = 8): Fill {
  const b = basin(side, wallTop)
  return (x, y, z) => {
    const v = b(x, y, z)
    if (v !== AIR) return v
    return x > 0 && x < side - 1 && z > 0 && z < side - 1 && y >= 1 && y <= top ? w(7) : AIR
  }
}
