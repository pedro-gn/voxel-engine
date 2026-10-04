import type { Command } from '@elovox/engine'
import { defineGenerator } from '@elovox/engine/sim-worker'
import { AIR, packVoxel } from '@elovox/engine/src/world/voxel.ts'

/** A test bed for 3a: a dammed lake above a dry valley, a spring-fed river into a small sea, sand on planks in the air. */
export const FLOOD_SIZE = [256, 64, 256] as const
/** Water fills y < SEA_LEVEL in the sea and the river mouth; the sea's pool (surface y = 11) is the cycle pool. */
export const SEA_LEVEL = 12
/** Default solid layers: a column with ground g is solid for y < g. */
export const GROUND = 25
/** 100 × 100 lake: bed solid below `floor`, water from `floor` to `top`. */
export const LAKE = { x0: 25, x1: 124, z0: 25, z1: 124, floor: 21, top: 24 } as const
/** The one-block dam on the lake's east side; the valley floor is far below it. */
export const DAM_X = 125
export const BREACH = { z0: 70, z1: 79 } as const
export const VALLEY = { x0: 126, x1: 250, z0: 10, z1: 245, ground: 9 } as const
export const SEA = { x1: 120, z0: 200, ground: 5 } as const
/** A channel that steps down one block every 4 from `head` toward the sea. */
export const RIVER = { x0: 8, x1: 12, z0: 136, z1: 199, head: 23 } as const
export const SPRING = { x: 10, z: 136, flow: 8 } as const
export const PILLARS = [{ x: 60, z: 160, base: 40, height: 8 }, { x: 70, z: 70, base: 40, height: 4 }] as const
/** The dig checkpoint's channel: west of the lake, opening straight into it (x 4..24, z 40..43). */
export const CHANNEL = { x0: 4, x1: LAKE.x0 - 1, z0: 40, z1: 43 } as const

export type FloodBlock = 'stone' | 'dirt' | 'grass' | 'sand' | 'water' | 'spring' | 'planks'

const inLake = (x: number, z: number) => x >= LAKE.x0 && x <= LAKE.x1 && z >= LAKE.z0 && z <= LAKE.z1
const inValley = (x: number, z: number) => x >= VALLEY.x0 && x <= VALLEY.x1 && z >= VALLEY.z0 && z <= VALLEY.z1
const inRiver = (x: number, z: number) => x >= RIVER.x0 && x <= RIVER.x1 && z >= RIVER.z0 && z <= RIVER.z1
const inSea = (x: number, z: number) => x <= SEA.x1 && z >= SEA.z0

/** Solid layers under (x, z). */
export function groundAt(x: number, z: number): number {
  if (inLake(x, z)) return LAKE.floor
  if (inValley(x, z)) return VALLEY.ground
  if (inRiver(x, z)) return RIVER.head - Math.floor((z - RIVER.z0) / 4)
  if (inSea(x, z)) return SEA.ground
  return GROUND
}

/** The scene's blocks for one column, bottom to top (index = y). Pure. */
export function floodColumn(x: number, z: number): (FloodBlock | null)[] {
  const col = new Array<FloodBlock | null>(FLOOD_SIZE[1]).fill(null)
  const g = groundAt(x, z)
  const top: FloodBlock = inLake(x, z) ? 'dirt' : inSea(x, z) || inRiver(x, z) ? 'sand' : 'grass'
  for (let y = 0; y < g; y++) col[y] = y === g - 1 ? top : y >= g - 4 ? 'dirt' : 'stone'
  if (inLake(x, z)) for (let y = g; y <= LAKE.top; y++) col[y] = 'water'
  else if (x <= SEA.x1 && g < SEA_LEVEL) for (let y = g; y < SEA_LEVEL; y++) col[y] = 'water'
  if (x === SPRING.x && z === SPRING.z) col[g] = 'spring'
  for (const p of PILLARS) {
    if (x !== p.x || z !== p.z) continue
    col[p.base] = 'planks'
    for (let y = p.base + 1; y <= p.base + p.height; y++) col[y] = 'sand'
  }
  return col
}

export const floodGenerator = defineGenerator({
  configure: () => ({ seaLevel: SEA_LEVEL }),
  generateColumn(ctx, cx, cz) {
    const ids: Record<FloodBlock, number> = {
      stone: ctx.id('stone'), dirt: ctx.id('dirt'), grass: ctx.id('grass'), sand: ctx.id('sand'),
      water: packVoxel(ctx.id('water'), 7), spring: packVoxel(ctx.id('spring'), SPRING.flow), planks: ctx.id('planks'),
    }
    for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
      const col = floodColumn(cx * 32 + lx, cz * 32 + lz)
      for (let y = 0; y < col.length; y++) {
        const b = col[y]
        if (b) ctx.set(lx, y, lz, ids[b])
      }
    }
  },
})

/** Opens the dam over BREACH, down to the lake floor. */
export function breachCommands(): Command[] {
  return [{ type: 'fillRegion', min: [DAM_X, LAKE.floor, BREACH.z0], max: [DAM_X, LAKE.top, BREACH.z1], voxel: AIR }]
}

/** Stops the river so the scene can settle: `stone` (the stone voxel) replaces the spring at its head. */
export function stopSpringCommands(stone: number): Command[] {
  return [{ type: 'setBlock', pos: [SPRING.x, groundAt(SPRING.x, SPRING.z), SPRING.z], voxel: stone }]
}

/**
 * The stress test: the whole dam opens (every row of the lake's east side) and a 40 × 40 × 4 block of
 * full water (`water`: the full water voxel) drops into the valley beside the breach.
 */
export function stressCommands(water: number): Command[] {
  const y0 = VALLEY.ground + 8
  return [
    { type: 'fillRegion', min: [DAM_X, LAKE.floor, LAKE.z0], max: [DAM_X, LAKE.top, LAKE.z1], voxel: AIR },
    { type: 'fillRegion', min: [160, y0, 55], max: [199, y0 + 3, 94], voxel: water },
  ]
}

/** Removes the planks under each sand pillar, so the pillars fall (one into the lake). */
export function dropCommands(): Command[] {
  return PILLARS.map((p) => ({ type: 'setBlock', pos: [p.x, p.base, p.z], voxel: AIR }))
}

/** Cuts CHANNEL through the ground down to the lake's floor: the lake runs into it. */
export function digCommands(): Command[] {
  return [{ type: 'fillRegion', min: [CHANNEL.x0, LAKE.floor, CHANNEL.z0], max: [CHANNEL.x1, GROUND - 1, CHANNEL.z1], voxel: AIR }]
}
