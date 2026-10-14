import type { Command, Vec3, WorkerOptions, WorkOrderView } from '@elovox/engine'
import { AIR } from '@elovox/engine/sim-worker'
import { WORKER_OPTIONS } from './workers.ts'

/** The living-world benchmark scene (4a): every system at once on the user's 512² reference world. */
export const LIVING_SIZE = [512, 128, 512] as const
/** A flat plateau: centre (x, z); `ground` is the first air y (the flatten op's `y`). */
export type Site = { readonly x: number; readonly z: number; readonly ground: number }
export const SITE_HALF = 24
/** Plateau centres and heights; living.terrain.json flattens exactly these. */
export const SITES = {
  reservoir: { x: 170, z: 200, ground: 58 },
  work: { x: 330, z: 200, ground: 46 },
  rest: { x: 330, z: 310, ground: 46 },
  tower: { x: 440, z: 300, ground: 46 },
} as const satisfies Record<string, Site>
export const UNITS = 50
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)
/** Unit ids are assigned 1, 2, … in spawn order, so crews are id ranges. */
export const CREWS = { tunnel: range(1, 14), bridge: range(15, 27), wall: range(28, 40), group: range(41, 50) } as const
export const LIVING_WORKER_OPTIONS: WorkerOptions = {
  ...WORKER_OPTIONS,
  materials: { ...WORKER_OPTIONS.materials, sand: { digTicks: 6, buildTicks: 6 }, gravel: { digTicks: 8, buildTicks: 6 }, snow: { digTicks: 4, buildTicks: 4 }, log: { digTicks: 12, buildTicks: 10 }, leaves: { digTicks: 2, buildTicks: 2 } },
}
export type Ids = { water: number; stone: number; planks: number; beam: number; glass: number; dirt: number }
type Box = { min: Vec3; max: Vec3 }

const fill = (min: Vec3, max: Vec3, voxel: number): Command => ({ type: 'fillRegion', min, max, voxel })
const o = (s: Site) => [s.x - SITE_HALF, s.z - SITE_HALF] as const

/** Removes trees, rocks and anything else from the footprint, 32 blocks up. */
export function clearCommands(s: Site): Command[] {
  const [x0, z0] = o(s)
  return [fill([x0, s.ground, z0], [x0 + 2 * SITE_HALF - 1, s.ground + 31, z0 + 2 * SITE_HALF - 1], AIR)]
}

/** A 32 × 32 stone basin, 8 high, with water 7 deep inside. */
export function reservoirInterior(s: Site): Box {
  const [x0, z0] = o(s)
  return { min: [x0 + 9, s.ground, z0 + 9], max: [x0 + 38, s.ground + 6, z0 + 38] }
}
export function reservoirCommands(s: Site, ids: Ids): Command[] {
  const [x0, z0] = o(s), inside = reservoirInterior(s)
  return [fill([x0 + 8, s.ground - 1, z0 + 8], [x0 + 39, s.ground + 7, z0 + 39], ids.stone), fill(inside.min, inside.max, ids.water)]
}
/** Opens 8 columns of the east wall, floor to top. */
export function breachCommands(s: Site): Command[] {
  const [x0, z0] = o(s)
  return [fill([x0 + 39, s.ground, z0 + 20], [x0 + 39, s.ground + 7, z0 + 27], AIR)]
}

/** The normal stone plinth under the tower; cutting it drops the tower. */
export function TOWER_BASE(s: Site): Box { return { min: [s.x - 4, s.ground, s.z - 4], max: [s.x + 3, s.ground + 3, s.z + 3] } }
/** The collapse scene's proven tower: an 8 × 8 structural shell, 27 high, with a glass band. */
export function towerCommands(s: Site, ids: Ids): Command[] {
  const b = TOWER_BASE(s), y0 = b.max[1] + 1, cmds: Command[] = [fill(b.min, b.max, ids.stone)]
  cmds.push(fill([b.min[0], y0, b.min[2]], [b.max[0], y0 + 26, b.max[2]], ids.beam))
  cmds.push(fill([b.min[0], y0 + 15, b.min[2]], [b.max[0], y0 + 18, b.max[2]], ids.glass))
  cmds.push(fill([b.min[0] + 1, y0, b.min[2] + 1], [b.max[0] - 1, y0 + 26, b.max[2] - 1], AIR))
  return cmds
}
export function collapseCommands(s: Site): Command[] { const b = TOWER_BASE(s); return [fill(b.min, b.max, AIR)] }

/** The 2 × 2 tunnel through the mound. */
export function TUNNEL(s: Site): Box { const [x0, z0] = o(s); return { min: [x0 + 4, s.ground, z0 + 23], max: [x0 + 11, s.ground + 1, z0 + 24] } }
/** The 2-wide plank deck across the channel, flush with the ground. */
export function BRIDGE(s: Site): Box { const [x0, z0] = o(s); return { min: [x0 + 18, s.ground - 1, z0 + 23], max: [x0 + 22, s.ground - 1, z0 + 24] } }
/** A 10 × 2 stone wall (a third row is out of a unit's reach from the ground). */
export function WALL(s: Site): Box { const [x0, z0] = o(s); return { min: [x0 + 30, s.ground, z0 + 10], max: [x0 + 39, s.ground + 1, z0 + 10] } }
/** A one-block-deep quarry every crew digs at low priority once its own job is done, so work lasts the whole benchmark. */
export function QUARRY(s: Site): Box { const [x0, z0] = o(s); return { min: [x0 + 26, s.ground - 1, z0 + 12], max: [x0 + 45, s.ground - 1, z0 + 29] } }
/** The stone mound to tunnel through and the channel to bridge. */
export function workSiteCommands(s: Site, ids: Ids): Command[] {
  const [x0, z0] = o(s)
  return [fill([x0 + 4, s.ground, z0 + 18], [x0 + 11, s.ground + 5, z0 + 29], ids.stone), fill([x0 + 18, s.ground - 3, z0 + 16], [x0 + 22, s.ground - 1, z0 + 31], AIR)]
}
/** 40 crew units in 8 × 5 rows, then the 10-unit group behind them, every unit with a pick and stock. */
export function spawnCommands(s: Site, ids: Ids): Command[] {
  const [x0, z0] = o(s), stock = [{ block: ids.planks, count: 32 }, { block: ids.stone, count: 32 }, { block: ids.dirt, count: 32 }]
  const at = (i: number): Vec3 => i < 40 ? [x0 + 26 + (i % 8) * 2, s.ground, z0 + 30 + Math.floor(i / 8) * 2] : [x0 + 26 + ((i - 40) % 5) * 2, s.ground, z0 + 41 + Math.floor((i - 40) / 5) * 2]
  return Array.from({ length: UNITS }, (_, i) => ({ type: 'unitSpawn', pos: at(i), tools: ['pick'], stock }) as Command)
}
export function workCommands(s: Site, ids: Ids): Command[] {
  const t = TUNNEL(s), b = BRIDGE(s), w = WALL(s), q = QUARRY(s)
  return [
    { type: 'workDig', min: t.min, max: t.max, ids: [...CREWS.tunnel] },
    { type: 'workBuild', min: b.min, max: b.max, voxel: ids.planks, ids: [...CREWS.bridge] },
    { type: 'workBuild', min: w.min, max: w.max, voxel: ids.stone, ids: [...CREWS.wall] },
    { type: 'workDig', min: q.min, max: q.max, ids: crewIds(), priority: 64 },
  ] as Command[]
}
const crewIds = () => [...CREWS.tunnel, ...CREWS.bridge, ...CREWS.wall]
const inQuarry = (o: WorkOrderView, q: Box) => o.min[0] === q.min[0] && o.min[1] === q.min[1] && o.min[2] === q.min[2] && o.max[0] === q.max[0] && o.max[1] === q.max[1] && o.max[2] === q.max[2]
/**
 * Keeps the crews busy for as long as the benchmark runs: once the latest quarry order is finished (or cancelled), the
 * opposite one: dug out → filled back with the dirt the crews carry → dug again. [] while a quarry order is open.
 */
export function quarryCycle(orders: readonly WorkOrderView[], s: Site, ids: Ids): Command[] {
  const q = QUARRY(s)
  let last: WorkOrderView | undefined
  for (const o of orders) if (inQuarry(o, q) && (!last || o.id > last.id)) last = o
  if (!last || (!last.cancelled && last.done < last.total)) return []
  return [last.kind === 'dig'
    ? { type: 'workBuild', min: q.min, max: q.max, voxel: ids.dirt, ids: crewIds(), priority: 64 } as Command
    : { type: 'workDig', min: q.min, max: q.max, ids: crewIds(), priority: 64 } as Command]
}
export function moveGroupCommands(to: Site): Command[] {
  return [{ type: 'unitMove', ids: [...CREWS.group], pos: [to.x, to.ground, to.z] } as Command]
}

type Camera = { target: [number, number, number]; distance: number; pitch: number; yaw: number }
export const CAMERAS: Record<'default' | 'far' | 'dam' | 'tower', Camera> = {
  default: { target: [SITES.work.x, SITES.work.ground, SITES.work.z], distance: 70, pitch: 0.8, yaw: 0.7 },
  far: { target: [256, 40, 256], distance: 400, pitch: 0.9, yaw: 0.7 },
  dam: { target: [SITES.reservoir.x + 50, SITES.reservoir.ground - 6, SITES.reservoir.z], distance: 400, pitch: 0.85, yaw: 0.3 },
  tower: { target: [SITES.tower.x, SITES.tower.ground + 12, SITES.tower.z], distance: 70, pitch: 0.6, yaw: 0.7 },
}
