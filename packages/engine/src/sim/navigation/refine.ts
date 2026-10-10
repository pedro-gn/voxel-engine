import type { Layout } from '../../world/layout.ts'
import { edgeCost } from './navigation.ts'
import { slotOf, type Region } from './regions.ts'

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
