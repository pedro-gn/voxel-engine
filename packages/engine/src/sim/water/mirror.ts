import { AIR } from '../../world/voxel.ts'
import { KIND, SUB } from './constants.ts'

/** A surface (1/SUB block) in eighths of a block, rounded: the cell holding it gets level round(frac × 8) − 1, air below 1/16 block. */
export function quantize(s: number): number { return (s + SUB / 16) >> 5 }

/**
 * The quantized surface (eighths) the mirror draws for a segment on `floor` holding `depth`: nothing under `shown`. With
 * shown = SUB / 16 this is quantize for any wet segment, since quantize already rounds a thinner film to its floor.
 */
export function mirrorQ(floor: number, depth: number, shown: number): number { return depth >= shown ? quantize(floor * SUB + depth) : floor * 8 }

/**
 * Makes one segment's cells match its water (spec §4 The voxel mirror; 3d: bounded by `ceil`): full cells under the
 * quantized surface, a partial cell at it, air above where water was, and air in cells a risen floor left under it (from
 * min(lo, floor)). Walls, springs and pass cells are never written; nothing at or above `ceil` is touched. `lo`/`q` hold the segment's
 * mirror state at index i (WaterMirror's arrays for a top segment, UnderSegments.mirrorLo / mirrorQ for a lower one).
 * A segment shallower than `shown` (WaterColumns.shown: SUB / 16, or the retain option above it) is drawn as dry.
 */
export function mirrorRun(lo: Int16Array, q: Int32Array, i: number, x: number, z: number, floor: number, ceil: number, depth: number,
  water: number, kind: Uint8Array, get: (x: number, y: number, z: number) => number, set: (x: number, y: number, z: number, v: number) => void,
  shown = SUB / 16): boolean {
  const nq = mirrorQ(floor, depth, shown)
  const oq = q[i]!, force = oq < 0, extent = force ? ~oq : oq
  const ol = lo[i]!
  if (!force && nq === oq && floor === ol) return false
  // With an unchanged floor and a valid mirror, cells below both surfaces are already full. Only their surface band
  // can differ. Edits (force) and floor changes still rebuild the complete run, including stray or displaced cells.
  const from = force || floor !== ol ? Math.min(ol, floor) : Math.max(floor, Math.min(extent >> 3, nq >> 3))
  const to = Math.min(ceil, Math.max((extent + 7) >> 3, (nq + 7) >> 3))
  const full = nq >> 3, part = nq & 7
  let wrote = false
  for (let y = from; y < to; y++) {
    const v = get(x, y, z), k = kind[v & 0xfff]!
    if (k === KIND.WALL || k === KIND.PASS) continue
    let want = AIR
    if (y >= floor) {
      if (y < full) want = water | (7 << 12)
      else if (y === full && part > 0) want = water | ((part - 1) << 12)
    }
    if (want === AIR ? k === KIND.WATER : v !== want) {
      set(x, y, z, want)
      wrote = true
    }
  }
  lo[i] = floor
  q[i] = nq
  return wrote
}

/**
 * Water voxels as a mirror of the heightfield (spec §4 The voxel mirror). Per column it remembers what the voxels hold, so a
 * flush writes only columns whose quantized water changed, and only the cells that differ.
 */
export class WaterMirror {
  /** Per column: the floor its cells were last written from. */
  readonly lo: Int16Array
  /** Per column: the quantized surface (eighths) its cells hold; ~e (negative) when they must be rewritten up to e eighths. */
  readonly q: Int32Array

  constructor(n: number) {
    this.lo = new Int16Array(n)
    this.q = new Int32Array(n)
  }

  /** An edit touched cell y of column c: rewrite the column at the next flush, up to that cell at least. */
  touch(c: number, y: number): void {
    const q = this.q[c]!, extent = q < 0 ? ~q : q
    this.q[c] = ~Math.max(extent, (y + 1) * 8)
  }

  /**
   * Makes column c's cells match its water: full cells under the quantized surface, a partial cell at it, air above where
   * water was, and air in cells a risen floor left under it. Walls and springs are never written; static water under the
   * old floor is never touched. `set` is a quiet write. Returns whether it wrote anything.
   */
  flush(c: number, x: number, z: number, floor: number, depth: number, water: number, kind: Uint8Array, height: number,
    get: (x: number, y: number, z: number) => number, set: (x: number, y: number, z: number, v: number) => void, shown = SUB / 16): boolean {
    return mirrorRun(this.lo, this.q, c, x, z, floor, height, depth, water, kind, get, set, shown)
  }

  mixState(mix: (v: number) => void): void {
    for (let c = 0; c < this.q.length; c++) { mix(this.lo[c]!); mix(this.q[c]!) }
  }
}
