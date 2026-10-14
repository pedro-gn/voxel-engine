import type { Command, Vec3, WorkerOptions } from '@elovox/engine'
import { Pcg32, AIR } from '@elovox/engine/sim-worker'
import { WORKER_OPTIONS } from './workers.ts'

/** The navigation-at-scale scene (5b): 1,000 units on a 1024² world with five flat pads. */
export const CROWD_SIZE = [1024, 128, 1024] as const
/** A 64 × 64 flat pad; `y` is the standing height (the flatten op's `y`), and min/max are the standing layer. */
export type Pad = { readonly min: Vec3; readonly max: Vec3; readonly y: number }
export type PadName = 'west' | 'east' | 'north' | 'south' | 'centre'
const pad = (x: number, z: number, y: number): Pad => ({ min: [x - 32, y, z - 32], max: [x + 31, y, z + 31], y })
/** crowd.terrain.json flattens exactly these boxes. */
export const PADS: Record<PadName, Pad> = {
  west: pad(160, 512, 48), east: pad(864, 512, 52), north: pad(512, 160, 56), south: pad(512, 864, 50), centre: pad(512, 512, 44),
}
export const CROWD_WORKER_OPTIONS: WorkerOptions = { ...WORKER_OPTIONS, maxUnits: 1000, maxOrders: 128 }
const PAD_NAMES = Object.keys(PADS) as PadName[]
/** The centre column of a pad; move orders aim here, on even offsets from the pad's corner. */
const centre = (p: Pad): Vec3 => [p.min[0] + 32, p.y, p.min[2] + 32]
const fill = (min: Vec3, max: Vec3, voxel: number): Command => ({ type: 'fillRegion', min, max, voxel })

/** Removes trees and rocks from every pad, 32 blocks up. */
export function padClearCommands(): Command[] {
  return Object.values(PADS).map(p => fill(p.min, [p.max[0], p.y + 31, p.max[2]], AIR))
}
/** Splits `count` units between `pads` in order; pad k gets the k-th share. */
function shares(count: number, pads: number): number[] {
  return Array.from({ length: pads }, (_, k) => Math.floor(count / pads) + (k < count % pads ? 1 : 0))
}
/**
 * `count` units split evenly between `pads`, each share filling its pad in rows on a 2-block grid at odd offsets (so
 * spawns never take a move formation's even cells). Unit ids follow this order.
 */
export function spawnCrowd(count: number, pads: PadName[], stock: { block: number; count: number }[] = []): Command[] {
  const cmds: Command[] = []
  shares(count, pads.length).forEach((n, k) => {
    if (n > 32 * 32) throw new RangeError(`at most 1024 units per pad, got ${n}`)
    const p = PADS[pads[k]!]
    for (let i = 0; i < n; i++) cmds.push({ type: 'unitSpawn', pos: [p.min[0] + 1 + 2 * (i % 32), p.y, p.min[2] + 1 + 2 * Math.floor(i / 32)], tools: ['pick'], ...(stock.length > 0 && { stock }) })
  })
  return cmds
}
export function massMove(ids: number[], to: PadName): Command {
  return { type: 'unitMove', ids, pos: centre(PADS[to]) }
}
/**
 * One move per 25 ids, each to a pad 200–800 blocks from the pad the group spawned on (`from`, split as spawnCrowd
 * splits), cycling through those pads from a seeded start, and aimed at a seeded point of the pad's middle.
 */
export function scatterMoves(ids: number[], seed: number, from: PadName[] = ['west', 'north']): Command[] {
  const rng = new Pcg32(seed), split = shares(ids.length, from.length), start = rng.nextInt(PAD_NAMES.length), cmds: Command[] = []
  for (let g = 0; g * 25 < ids.length; g++) {
    let k = 0, at = g * 25
    while (at >= split[k]!) at -= split[k++]!
    const [sx, , sz] = centre(PADS[from[k]!])
    const valid = PAD_NAMES.filter(n => { const [x, , z] = centre(PADS[n]), d = Math.hypot(x - sx, z - sz); return d >= 200 && d <= 800 })
    const [x, y, z] = centre(PADS[valid[(start + g) % valid.length]!])
    cmds.push({ type: 'unitMove', ids: ids.slice(g * 25, g * 25 + 25), pos: [x + 2 * (rng.nextInt(17) - 8), y, z + 2 * (rng.nextInt(17) - 8)] })
  }
  return cmds
}
/**
 * A stone wall across the whole world, full height, on the east pad's west edge (x 832), with a 1-wide gate at z 500 and
 * a 2-wide gate at z 520–521. The wall's top at the pad's ground is the gates' floor, flush with the pad.
 */
export function bottleneckCommands(stone: number): Command[] {
  const x = PADS.east.min[0], y = PADS.east.y, top = CROWD_SIZE[1] - 1
  return [fill([x, 0, 0], [x, top, CROWD_SIZE[2] - 1], stone), fill([x, y, 500], [x, top, 500], AIR), fill([x, y, 520], [x, top, 521], AIR)]
}
/**
 * 20 orders, four per pad, away from the first 16 spawn rows: digs of the top layer and two-row builds on it. The
 * first order on the west and east pads is a 20 × 20 dig, larger than the 256-slot frontier.
 */
export function workOrders(stone: number, planks: number): Command[] {
  const cmds: Command[] = []
  for (const name of PAD_NAMES) {
    const p = PADS[name], x0 = p.min[0], z0 = p.min[2], y = p.y, big = name === 'west' || name === 'east' ? 20 : 8
    cmds.push(
      { type: 'workDig', min: [x0 + 4, y - 1, z0 + 33], max: [x0 + 3 + big, y - 1, z0 + 32 + big] },
      { type: 'workDig', min: [x0 + 36, y - 1, z0 + 33], max: [x0 + 43, y - 1, z0 + 40] },
      { type: 'workBuild', min: [x0 + 36, y, z0 + 50], max: [x0 + 43, y, z0 + 51], voxel: planks },
      { type: 'workBuild', min: [x0 + 50, y, z0 + 50], max: [x0 + 57, y, z0 + 51], voxel: stone },
    )
  }
  return cmds
}
