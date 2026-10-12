import type { Layout } from '../../world/layout.ts'
import { edgeCost } from './navigation.ts'
import { UNREACHED, exitKey, slotOf, type Region } from './regions.ts'

/**
 * Walks down a region field from `from` to a pose of cost 0, taking at each pose the first direction whose step is
 * optimal and allowed. `field` is an exit index (that exit's field) or a field over the region's slots. One operation
 * per step and one per inspected edge, so at most 1 + 5 × maxSteps. `ok` is false when no allowed optimal step exists
 * before cost 0, or when `maxSteps` ran out first (`cut`): the path is then an optimal prefix to continue from.
 */
export function descend(region: Region, field: Uint16Array | number, from: number, allowed: (p: number) => boolean, layout: Layout, maxSteps = 256): { path: number[]; ops: number; ok: boolean; cut: boolean } {
  const P = region.poses.length, base = typeof field === 'number' ? field * P : 0, values = typeof field === 'number' ? region.fields : field
  const path = [from]
  let slot = slotOf(region, from, layout), ops = 1
  if (slot < 0 || values[base + slot] === undefined) return { path, ops, ok: false, cut: false }
  for (let steps = 0; values[base + slot]! > 0; steps++) {
    if (steps === maxSteps) return { path, ops, ok: false, cut: true }
    const here = values[base + slot]!, pose = region.poses[slot]!
    let moved = -1
    for (let d = 0; d < 4 && moved < 0; d++) {
      const t = region.next[slot * 4 + d]!
      ops++
      if (t >= 0 && values[base + t]! + edgeCost(layout, pose, region.poses[t]!) === here && allowed(region.poses[t]!)) moved = t
    }
    ops++
    if (moved < 0) return { path, ops, ok: false, cut: false }
    slot = moved; path.push(region.poses[slot]!)
  }
  return { path, ops, ok: true, cut: false }
}

/** What a settled route search or group field knows about the way to its goals. */
export interface Corridor {
  /** The record the search read for a tile, whatever its epoch now. */
  region(index: number): Region | undefined
  /** Cost to the goals from the `from` pose of exit `key` (1 + region*4096 + e), or Infinity when unknown. */
  toGo(key: number): number
  /** Cost to the goals from each slot of a goal region's record, for the goal regions the search read. */
  readonly goalFields: ReadonlyMap<number, Uint16Array>
}
/**
 * The best way on from `slot` of `region`, a record at its tile's current revision: an exit index and the cost to the
 * goals through it, or e = -1 when `goal` (a cost to the goals over the region's slots) is cheaper. When the corridor
 * read this very record, its own costs price each exit; an exit they do not price (the tile changed since, the
 * corridor never read it, or it leaves the corridor) is priced one region further on, through the record the corridor
 * read there, so a unit recovers locally from an edit, a detour or an excluded exit. Exits whose `from` pose is
 * excluded are skipped. `ops` counts the exits probed.
 */
export function nextHop(c: Corridor, region: Region, slot: number, layout: Layout, exclude: readonly number[], goal?: Uint16Array): { e: number; cost: number; ops: number } | null {
  const P = region.poses.length, own = c.region(region.index) === region
  let e = -1, cost = goal && goal[slot] !== UNREACHED ? goal[slot]! : Infinity, ops = 1
  for (let i = 0; i < region.exits.length; i++) {
    const x = region.exits[i]!, here = region.fields[i * P + slot]!
    ops++
    if (here === UNREACHED || exclude.includes(x.from)) continue
    let on = own ? c.toGo(exitKey(region.index, i)) : Infinity
    if (on === Infinity) {
      // One region further on: the cost from where the crossing lands, through the record the corridor read there.
      const t = c.region(x.target), ts = t ? slotOf(t, x.to, layout) : -1
      if (t && ts >= 0) {
        const T = t.poses.length, g = c.goalFields.get(t.index)?.[ts]
        if (g !== undefined && g !== UNREACHED) on = g
        for (let j = 0; j < t.exits.length; j++) {
          const f = t.fields[j * T + ts]!
          ops++
          // A way on back through this region was priced on what the corridor read here, which no longer holds.
          if (f !== UNREACHED && t.exits[j]!.target !== region.index) on = Math.min(on, f + c.toGo(exitKey(t.index, j)))
        }
        on += x.cost
      }
    }
    if (here + on < cost) { cost = here + on; e = i }
  }
  return cost === Infinity ? null : { e, cost, ops }
}
