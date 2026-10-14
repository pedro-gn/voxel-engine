import type { Command } from '@elovox/engine'
import { defineGenerator, AIR, packVoxel } from '@elovox/engine/sim-worker'

/** A test bed for 3d (multi-layer water): every layered case in one 128 × 64 × 128 world, closed until a hook opens it. */
export const CAVES_SIZE = [128, 64, 128] as const
/** Default solid layers: a column is solid for y < GROUND. */
export const GROUND = 32
/** A lake (bed solid below `floor`, water floor..top). */
export const LAKE = { x0: 8, x1: 47, z0: 8, z1: 47, floor: 20, top: 27 } as const
/** A dry tunnel east of the lake (cells y0–y1, z0–z1) from x0 to x1, closed at the lake by a plug at x = plug (dug by digTunnel). */
export const TUNNEL = { plug: 48, x0: 49, x1: 79, z0: 27, z1: 28, y0: 22, y1: 23 } as const
/** A shaft at the tunnel's far end, open from the tunnel's floor to the sky. */
export const SHAFT = { x0: 80, x1: 81, z0: 27, z1: 28 } as const
/** A shallow pond (one block of water on a bed at `floor`). */
export const POND = { x0: 64, x1: 95, z0: 8, z1: 23, floor: 30 } as const
/** A dry cave under the pond (cells y0–y1), its roof from `roof` to the pond's bed. */
export const CAVE = { x0: 68, x1: 91, z0: 10, z1: 21, y0: 18, y1: 27, roof: 28 } as const
/** The lake's south bank, one block thick, with the valley right behind it (openDam opens a hole at the lake's floor). */
export const DAM = { z: 48, hole: { x0: 26, x1: 29 } } as const
export const VALLEY = { x0: 0, x1: 90, z0: 49, z1: 120, floor: 10 } as const
/** A canal (bed solid below `floor`, water floor..top) along z, with a high bridge (deck above the water) and a low one (deck in it). */
export const CANAL = { x0: 100, x1: 103, floor: 26, top: 29 } as const
export const BRIDGES = [{ z: 40, deck: 31 }, { z: 60, deck: 29 }] as const
/** Where openCanal cuts the canal's west bank into the valley. */
export const CUT = { x0: 91, x1: 99, z0: 100, z1: 103 } as const

export type CaveBlock = 'stone' | 'dirt' | 'grass' | 'water'

const inLake = (x: number, z: number) => x >= LAKE.x0 && x <= LAKE.x1 && z >= LAKE.z0 && z <= LAKE.z1
const inPond = (x: number, z: number) => x >= POND.x0 && x <= POND.x1 && z >= POND.z0 && z <= POND.z1
const inCave = (x: number, z: number) => x >= CAVE.x0 && x <= CAVE.x1 && z >= CAVE.z0 && z <= CAVE.z1
const inValley = (x: number, z: number) => x >= VALLEY.x0 && x <= VALLEY.x1 && z >= VALLEY.z0 && z <= VALLEY.z1
const inCanal = (x: number) => x >= CANAL.x0 && x <= CANAL.x1
const inTunnelZ = (z: number) => z >= TUNNEL.z0 && z <= TUNNEL.z1
const inShaft = (x: number, z: number) => x >= SHAFT.x0 && x <= SHAFT.x1 && z >= SHAFT.z0 && z <= SHAFT.z1

/** Solid layers under (x, z) before carving. */
function groundAt(x: number, z: number): number {
  if (inLake(x, z)) return LAKE.floor
  if (inPond(x, z)) return POND.floor
  if (inValley(x, z)) return VALLEY.floor
  if (inCanal(x)) return CANAL.floor
  return GROUND
}

/** The scene's blocks for one column, bottom to top (index = y). Pure. */
export function cavesColumn(x: number, z: number): (CaveBlock | null)[] {
  const col = new Array<CaveBlock | null>(CAVES_SIZE[1]).fill(null)
  const g = groundAt(x, z)
  for (let y = 0; y < g; y++) col[y] = y === g - 1 ? (inLake(x, z) || inPond(x, z) || inCanal(x) ? 'dirt' : 'grass') : y >= g - 4 ? 'dirt' : 'stone'
  if (inLake(x, z)) for (let y = LAKE.floor; y <= LAKE.top; y++) col[y] = 'water'
  if (inPond(x, z)) col[POND.floor] = 'water'
  if (inCanal(x)) for (let y = CANAL.floor; y <= CANAL.top; y++) col[y] = 'water'
  if (inCave(x, z)) for (let y = CAVE.y0; y <= CAVE.y1; y++) col[y] = null
  if (inTunnelZ(z) && x >= TUNNEL.x0 && x <= TUNNEL.x1) for (let y = TUNNEL.y0; y <= TUNNEL.y1; y++) col[y] = null
  if (inShaft(x, z)) for (let y = TUNNEL.y0; y < col.length; y++) col[y] = null
  for (const b of BRIDGES) if (z === b.z && x >= CANAL.x0 - 1 && x <= CANAL.x1 + 1) col[b.deck] = 'stone'
  return col
}

export const cavesGenerator = defineGenerator({
  generateColumn(ctx, cx, cz) {
    const ids: Record<CaveBlock, number> = { stone: ctx.id('stone'), dirt: ctx.id('dirt'), grass: ctx.id('grass'), water: packVoxel(ctx.id('water'), 7) }
    for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
      const col = cavesColumn(cx * 32 + lx, cz * 32 + lz)
      for (let y = 0; y < col.length; y++) {
        const b = col[y]
        if (b) ctx.set(lx, y, lz, ids[b])
      }
    }
  },
})

/** Digs the tunnel's plug: the lake runs into the tunnel and lifts the shaft. */
export function digTunnelCommands(): Command[] {
  return [{ type: 'fillRegion', min: [TUNNEL.plug, TUNNEL.y0, TUNNEL.z0], max: [TUNNEL.plug, TUNNEL.y1, TUNNEL.z1], voxel: AIR }]
}
/** Pierces the cave's roof under the pond's middle. */
export function pierceRoofCommands(): Command[] {
  return [{ type: 'fillRegion', min: [80, CAVE.roof, 15], max: [80, POND.floor - 1, 15], voxel: AIR }]
}
/** Opens a hole through the dam at the lake's floor, two blocks high, the dam solid above it. */
export function openDamCommands(): Command[] {
  return [{ type: 'fillRegion', min: [DAM.hole.x0, LAKE.floor, DAM.z], max: [DAM.hole.x1, LAKE.floor + 1, DAM.z], voxel: AIR }]
}
/** Cuts the canal's west bank into the valley: the canal runs under both bridges toward the cut. */
export function openCanalCommands(): Command[] {
  return [{ type: 'fillRegion', min: [CUT.x0, CANAL.floor, CUT.z0], max: [CUT.x1, GROUND - 1, CUT.z1], voxel: AIR }]
}
