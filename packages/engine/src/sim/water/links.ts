import type { WaterColumns } from './columns.ts'
import { RANKS, SUB } from './constants.ts'
import { ceilOf, depthOf, floorOf, segmentsOf } from './edges.ts'
import type { UnderSegments } from './under.ts'

/** A link to dry ground: LINK_GROUND | its height (blocks). */
export const LINK_GROUND = 0x8000
/** No segment of the neighbour overlaps, or the one met is ranked past the draw layers: a wall. */
export const LINK_WALL = 0x7fff
/** Ints per record of WaterTick.layers (plan design notes: Publishing). */
export const RECORD = 6
/** Sides in link order: +x, −x, +z, −z (render/water/surfaceMesh.ts DIR_X / DIR_Z). */
export const SIDE_X: readonly number[] = [1, -1, 0, 0]
export const SIDE_Z: readonly number[] = [0, 0, 1, -1]

/** Draw rank of segment ref: 0 for the top; for a lower one, the lower segments above it plus one. */
export function rankOf(ref: number, n: number, under: UnderSegments): number { return ref < n ? 0 : under.rankOf(ref - n) }

/**
 * The link of segment `ref` of column c on side dir, the neighbour column lying in the world (plan decision 13): among the
 * neighbour's segments overlapping ref's run, the one with the highest floor below ref's surface, else the lowest; its rank
 * when it is a top or drawn (`shown`), LINK_GROUND | its floor when it is a dry lower one, LINK_WALL when none overlaps, the
 * one met ranks past RANKS − 1, its ceiling is at or under ref's surface (the face at the water line is rock: no curtain is
 * hung on it), or it is a lower segment full to its ceiling or in a body (`hidden`: its water has no free surface).
 */
export function linkOf(ref: number, c: number, dir: number, cols: WaterColumns, under: UnderSegments, height: number,
  shown: (ref: number) => boolean, scratch: number[], hidden: (ref: number) => boolean = () => false): number {
  const nc = c + SIDE_X[dir]! + SIDE_Z[dir]! * cols.sx
  const f = floorOf(ref, cols, under), ce = ceilOf(ref, cols, under, height), S = f * SUB + depthOf(ref, cols, under)
  segmentsOf(nc, under, scratch)
  let best = -1, bestF = -1, low = -1, lowF = Infinity
  for (const r of scratch) {
    const rf = floorOf(r, cols, under), rc = ceilOf(r, cols, under, height)
    if (rf >= ce || rc <= f || rf >= rc) continue
    if (rf * SUB < S && rf > bestF) { best = r; bestF = rf }
    if (rf < lowF) { low = r; lowF = rf }
  }
  const m = best >= 0 ? best : low
  if (m < 0) return LINK_WALL
  const rank = rankOf(m, cols.n, under)
  if (rank >= RANKS || ceilOf(m, cols, under, height) * SUB <= S || hidden(m)) return LINK_WALL
  if (m < cols.n || shown(m)) return rank
  return LINK_GROUND | floorOf(m, cols, under)
}
