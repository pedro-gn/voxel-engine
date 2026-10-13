import { defineBlock, type BlockDef } from '../src/blocks/registry.ts'
import type { Command } from '../src/sim/commands.ts'
import { defineRules } from '../src/sim/rules.ts'
import { Simulation, type SimulationOptions } from '../src/sim/simulation.ts'
import type { SimRestore, SimSnapshot } from '../src/sim/snapshot.ts'
import { createWorldBuffers, type WorldBuffers } from '../src/world/buffers.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, WATER_BLOCKS, fillGenerator, w } from './waterHelpers.ts'

export const RICH_BLOCKS: BlockDef[] = [...WATER_BLOCKS, defineBlock({ name: 'beam', collapses: true }), defineBlock({ name: 'planks' })]
export const R = { ...B, beam: 10, planks: 11 } as const
export const RICH_SIZE: [number, number, number] = [64, 32, 64]

/** Dirt schedules itself when a neighbour changes and slides down into air: keeps the scheduler busy. */
const RULES = defineRules({ blocks: {
  dirt: {
    onNeighborChanged(ctx, x, y, z) { ctx.schedule(x, y, z, 2 + Math.floor(ctx.random() * 3)) },
    onScheduledTick(ctx, x, y, z, v) { if (y > 4 && ctx.isAir(ctx.get(x, y - 1, z))) { ctx.set(x, y, z, AIR); ctx.set(x, y - 1, z, v) } },
  },
} })

export function richOptions(buffers: WorldBuffers): SimulationOptions {
  return { buffers, blocks: RICH_BLOCKS, rules: RULES, seed: 5, randomTicksPerChunk: 0, log: () => {},
    workers: { materials: { stone: { digTicks: 4, buildTicks: 3 }, planks: { digTicks: 2, buildTicks: 3 } } } }
}

/** Stone floor (y < 4); a walled basin of water at x, z ∈ [4, 15]; a beam bridge on two stone posts at z = 30. */
function richFill(x: number, y: number, z: number): number {
  if (y < 4) return R.stone
  const inBasin = x >= 4 && x <= 15 && z >= 4 && z <= 15
  if (inBasin && (x === 4 || x === 15 || z === 4 || z === 15) && y <= 9) return R.stone
  if (inBasin && y <= 8) return w(7)
  if (z === 30 && (x === 20 || x === 26) && y <= 8) return R.stone
  if (z === 30 && x >= 20 && x <= 26 && y === 9) return R.beam
  return AIR
}

export function richSim(): Simulation {
  const sim = new Simulation(richOptions(createWorldBuffers(RICH_SIZE)))
  const gen = fillGenerator(richFill)
  sim.configure(gen, null)
  sim.generate(gen)
  return sim
}

let seq = 0
const submit = (sim: Simulation, cmd: Command) => sim.submit(0, ++seq, cmd)
/** Everything at once: units, a dig and a build order, a breached basin, falling dirt and sand, a falling beam, a long walk. */
export function richScript(sim: Simulation, t: number): void {
  if (t === 0) { submit(sim, { type: 'unitSpawn', pos: [40, 4, 40], stock: [{ block: R.planks, count: 30 }] }); submit(sim, { type: 'unitSpawn', pos: [44, 4, 40] }) }
  if (t === 2) submit(sim, { type: 'workDig', min: [48, 3, 48], max: [50, 3, 50] })
  if (t === 3) submit(sim, { type: 'workBuild', min: [36, 4, 50], max: [38, 5, 52], voxel: R.planks })
  if (t === 6) submit(sim, { type: 'fillRegion', min: [15, 5, 8], max: [15, 9, 11], voxel: AIR })
  if (t === 8) for (let x = 30; x < 34; x++) submit(sim, { type: 'setBlock', pos: [x, 20, 20], voxel: R.dirt })
  if (t === 9) submit(sim, { type: 'setBlock', pos: [34, 25, 25], voxel: R.sand })
  // Remove the east post, then cut the beam next to the west post: the east part falls as one fragment.
  if (t === 10) submit(sim, { type: 'fillRegion', min: [26, 4, 30], max: [26, 8, 30], voxel: AIR })
  if (t === 11) submit(sim, { type: 'setBlock', pos: [21, 9, 30], voxel: AIR })
  if (t === 12) submit(sim, { type: 'unitMove', ids: [2], pos: [60, 4, 10] })
}

/** The SimRestore a full snapshot stands for (every region was included). */
export function toRestore(s: SimSnapshot): SimRestore {
  return { tick: s.tick, paused: s.paused, regions: s.regions, sections: Object.fromEntries(s.sections.map(x => [x.name, x.bytes])) }
}

/** A new Simulation (same options, fresh buffers) restored from a full snapshot. */
export function restored(s: SimSnapshot): Simulation {
  const sim = new Simulation(richOptions(createWorldBuffers(RICH_SIZE)))
  sim.configure(fillGenerator(richFill), null)
  sim.restore(toRestore(s))
  return sim
}
export const fullRestore = (sim: Simulation): Simulation => restored(sim.snapshot(null))

export function voxelsEqual(a: Simulation, b: Simulation): boolean {
  const [sx, sy, sz] = a.layout.size
  for (let y = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) if (a.store.getVoxel(x, y, z) !== b.store.getVoxel(x, y, z)) return false
  return true
}
