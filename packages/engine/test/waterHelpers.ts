import { defineBlock, type BlockDef } from '../src/blocks/registry.ts'
import { defineGenerator, type GeneratorModule } from '../src/sim/generator.ts'
import type { RulesModule } from '../src/sim/rules.ts'
import type { GameSystem } from '../src/sim/systems.ts'
import { Simulation } from '../src/sim/simulation.ts'
import type { WaterOptions } from '../src/sim/water/waterSystem.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { AIR, packVoxel } from '../src/world/voxel.ts'
import { TEST_BLOCKS } from './helpers.ts'

export const WATER_BLOCKS: BlockDef[] = [
  ...TEST_BLOCKS,
  defineBlock({ name: 'sand', falls: true }),
  defineBlock({ name: 'spring', liquid: true, source: 'water', textures: 'water' }),
]
export const B = { air: 0, stone: 1, dirt: 2, grass: 3, glass: 4, water: 5, torch: 6, leaves: 7, sand: 8, spring: 9 } as const
/** A water voxel at a level (0–7). */
export const w = (level = 7): number => packVoxel(B.water, level)
export const spring = (flow = 5): number => packVoxel(B.spring, flow)

export type Fill = (x: number, y: number, z: number) => number
export interface WaterSimOptions {
  size?: [number, number, number]
  /** Handed to the sim through the generator's configure(). */
  seaLevel?: number
  seed?: number
  water?: Partial<WaterOptions>
  rules?: RulesModule
  log?: (message: string) => void
  /** The block table; default WATER_BLOCKS. */
  blocks?: BlockDef[]
  systems?: GameSystem[]
}

/** A generator that writes `fill` for every voxel, and reports `seaLevel` from configure() when given. */
export function fillGenerator(fill: Fill, seaLevel?: number): GeneratorModule {
  return defineGenerator({
    configure: () => (seaLevel === undefined ? undefined : { seaLevel }),
    generateColumn(ctx, cx, cz) {
      for (let y = 0; y < ctx.height; y++) for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
        const v = fill(cx * 32 + lx, y, cz * 32 + lz)
        if (v !== AIR) ctx.column[lx + (lz << 5) + (y << 10)] = v
      }
    },
  })
}

/** A Simulation generated from `fill` (32³ unless `size` says otherwise), without random ticks. */
export function waterSim(fill: Fill, o: WaterSimOptions = {}): Simulation {
  const sim = new Simulation({
    buffers: createWorldBuffers(o.size ?? [32, 32, 32]), blocks: o.blocks ?? WATER_BLOCKS, rules: o.rules, systems: o.systems, seed: o.seed ?? 1,
    log: o.log ?? (() => {}), water: o.water, randomTicksPerChunk: 0,
  })
  const gen = fillGenerator(fill, o.seaLevel)
  sim.configure(gen, null)
  sim.generate(gen)
  return sim
}

export function run(sim: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) sim.step()
}

/** Steps (at least once) until no physics work is left: no tile awake, no region job, nothing falling. Returns the ticks. */
export function settle(sim: Simulation, max = 20_000): number {
  for (let i = 1; i <= max; i++) if (!sim.step().physics.busy) return i
  throw new Error(`water still moving after ${max} ticks (${sim.water.stats().tiles} tiles awake)`)
}

/** A stone box: floor y = 0, walls at x/z = 0 and side − 1 up to `wallTop`, air inside and around. */
export function basin(side: number, wallTop: number): Fill {
  return (x, y, z) => {
    if (y === 0) return B.stone
    if ((x === 0 || z === 0 || x === side - 1 || z === side - 1) && y <= wallTop && x < side && z < side) return B.stone
    return AIR
  }
}

/** A basin of side `side` (walls to `wallTop`) holding full water for 1 ≤ y ≤ top. */
export function lake(top: number, side = 12, wallTop = 8): Fill {
  const b = basin(side, wallTop)
  return (x, y, z) => {
    const v = b(x, y, z)
    if (v !== AIR) return v
    return x > 0 && x < side - 1 && z > 0 && z < side - 1 && y >= 1 && y <= top ? w(7) : AIR
  }
}

/** Σ surface (1/SUB block) over columns [x0, x1] × [z0, z1]. */
export function surfaceSum(sim: Simulation, x0: number, z0: number, x1: number, z1: number): number {
  let s = 0
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) s += sim.water.column(x, z).surface
  return s
}

/** Σ depth (1/SUB block) over columns [x0, x1] × [z0, z1]. */
export function depthSum(sim: Simulation, x0: number, z0: number, x1: number, z1: number): number {
  let s = 0
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) s += sim.water.column(x, z).depth
  return s
}
