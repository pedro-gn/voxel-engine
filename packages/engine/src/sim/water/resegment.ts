import { KIND, SUB, UNIT } from './constants.ts'

/** A segment of a column before a write: cells [floor, ceil), its water (1/SUB block) and its identity. */
export interface Seg { floor: number; ceil: number; depth: number; id: number }
/** A run of non-wall cells after the write: the old segment it continues (`id`, −1 when new) and its water, which may exceed its capacity. */
export interface Run { floor: number; ceil: number; depth: number; id: number }
export interface Resegmented {
  /** Bottom-up; the last is the top segment (ceil = height). */
  runs: Run[]
  /** Water a wall placed in the top segment displaced, already in the top run's depth: WaterSystem spreads it (plan decision 8). */
  topDisplaced: number
}

/** The runs of non-wall cells of a column, bottom-up; the last is the top run, reaching `height` (empty when the top cell is a wall). */
export function runsOf(height: number, kindAfter: (y: number) => number): Run[] {
  const runs: Run[] = []
  let f = -1
  for (let y = 0; y < height; y++) {
    if (kindAfter(y) === KIND.WALL) {
      if (f >= 0) { runs.push({ floor: f, ceil: y, depth: 0, id: -1 }); f = -1 }
    } else if (f < 0) f = y
  }
  runs.push(f >= 0 ? { floor: f, ceil: height, depth: 0, id: -1 } : { floor: height, ceil: height, depth: 0, id: -1 })
  return runs
}

/** The run holding cell y; the top run for a cell no run holds (at or above the world's top). */
function runAt(runs: Run[], y: number): Run {
  for (const r of runs) if (y >= r.floor && y < r.ceil) return r
  return runs[runs.length - 1]!
}

/**
 * One voxel write at cell y of a column (3d spec §5 Edits; plan design notes: Edits). `old`: the column's segments before
 * the write, bottom-up, the top last; `kindAfter(y)`: every cell's KIND after it. Volume is exact: the runs hold the old
 * water, minus what a command removed, plus what it placed.
 * - Water a command removes (overwritten by anything but a wall): the cell's share of its segment, as in 3c.
 * - A wall placed in a segment's cell y: the water below y stays below, the cell's own water is displaced, the water above
 *   goes to the run above. Displaced water in the top goes into the top run's depth and is reported (`topDisplaced`); in a
 *   lower segment it goes to the run above, else to the run below (over its capacity); a filled one-cell pocket sends it up.
 * - Water placed: its units go to the run holding y.
 * Each lower run continues the first unused old lower segment with its floor, else one lying inside it, else one with its
 * ceiling; the top run continues the top.
 */
export function resegment(old: readonly Seg[], height: number, kindAfter: (y: number) => number,
  y: number, oldKind: number, newKind: number, newUnits: number): Resegmented {
  const runs = runsOf(height, kindAfter)
  const topRun = runs[runs.length - 1]!
  let topDisplaced = 0
  for (let k = 0; k < old.length; k++) {
    const s = old[k]!, isTop = k === old.length - 1
    const holds = y >= s.floor && y < s.ceil
    let d = s.depth
    if (holds && oldKind === KIND.WATER && newKind !== KIND.WALL) {
      d = Math.max(0, d - Math.min(SUB, Math.max(0, s.floor * SUB + d - y * SUB)))
    }
    if (holds && newKind === KIND.WALL && oldKind !== KIND.WALL) {
      const below = Math.min(d, (y - s.floor) * SUB)
      const cell = Math.min(SUB, d - below)
      const above = d - below - cell
      if (below > 0) runAt(runs, y - 1).depth += below
      if (above > 0) runAt(runs, y + 1).depth += above
      if (cell > 0) {
        if (isTop || (y === s.floor && y + 1 === s.ceil)) { topRun.depth += cell; topDisplaced += cell }
        else if (y + 1 < s.ceil) runAt(runs, y + 1).depth += cell
        else runAt(runs, y - 1).depth += cell
      }
      continue
    }
    if (d > 0) runAt(runs, s.floor).depth += d
  }
  if (newKind === KIND.WATER) runAt(runs, y).depth += newUnits * UNIT
  const used = new Set<number>()
  const lower = old.slice(0, -1)
  for (let i = 0; i < runs.length - 1; i++) {
    const r = runs[i]!
    const s = lower.find((o) => !used.has(o.id) && o.floor === r.floor)
      ?? lower.find((o) => !used.has(o.id) && o.floor >= r.floor && o.ceil <= r.ceil)
      ?? lower.find((o) => !used.has(o.id) && o.ceil === r.ceil)
    if (s) { r.id = s.id; used.add(s.id) }
  }
  topRun.id = old[old.length - 1]!.id
  return { runs, topDisplaced }
}
