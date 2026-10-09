import type { WaterBuffers } from '../../world/waterBuffers.ts'
import { moved, type WaterColumns } from './columns.ts'
import { FLUX_FP, RANKS, SUB, TILE } from './constants.ts'
import type { WaterEdges } from './edges.ts'
import { LINK_GROUND, LINK_WALL, SIDE_X, SIDE_Z } from './links.ts'
import type { UnderSegments } from './under.ts'

/** One publish: its sequence number, the parity buffer it wrote, its tiles, and their layer records (3d; null without lower segments). */
export interface WaterTick { seq: number; parity: number; tiles: readonly number[]; layers: Int32Array | null }

function clamp16(v: number): number { return v > 32767 ? 32767 : v < -32768 ? -32768 : v }

/** A column at least this deep (1/SUB block) is drawn: the renderer's threshold (render/water/surfaceMesh.ts SHOW_MIN). */
export const SHOW_DEPTH = SUB / 16
/** A drawn column stays drawn until it is shallower than this: it is published at least SHOW_DEPTH deep until then. */
export const HIDE_DEPTH = SUB / 32

/**
 * The sorted union of two sorted tile lists. When one side is empty the other comes back as is, so the result may be one of
 * the inputs: neither is modified, and callers must not modify the result.
 */
export function mergeTiles(a: readonly number[], b: readonly number[]): readonly number[] {
  if (b.length === 0) return a
  if (a.length === 0) return b
  const out: number[] = []
  let i = 0, j = 0
  while (i < a.length || j < b.length) {
    const v = j >= b.length || (i < a.length && a[i]! < b[j]!) ? a[i++]! : b[j++]!
    if (out.length === 0 || out[out.length - 1] !== v) out.push(v)
  }
  return out
}

/**
 * Writes the heightfield into the shared double buffer. Publish n writes into parity n & 1 the tiles that changed since the
 * last publish plus that publish's tiles, so each parity buffer is complete as of its last publish. The stamp brackets the
 * write (−1 while writing), so a reader can tell a buffer that was reused under it.
 * A thin film is drawn with hysteresis: it shows from SHOW_DEPTH and hides below HIDE_DEPTH, published at SHOW_DEPTH in
 * between. The step's films swing across one threshold where water spreads (a rising lake's shore, a flood's front), and
 * each swing moved the drawn shoreline a whole column back and forth.
 */
export class WaterPublisher {
  private readonly surface: Int32Array
  private readonly flux: Int16Array
  private readonly stamp: Int32Array
  /** Per column: 1 while it is drawn (SHOW_DEPTH reached, HIDE_DEPTH not left). */
  private shown = new Uint8Array(0)
  private seq = 0
  private last: readonly number[] = []
  /** Wet lower segments ranked past RANKS − 1 in the tiles last published, over all tiles (EngineStats.waterLayersHidden). */
  hidden = 0
  private readonly hiddenOf = new Map<number, number>()
  private rec = new Int32Array(1024)
  private recN = 0
  /**
   * records' flux sums: water moved last step through each segment's +x / +z sides, summed over the tile's edges, by segment
   * ref. An entry counts only when its stamp is the current tile's `gen`, so nothing is cleared between tiles.
   */
  private sumX = new Float64Array(0)
  private sumZ = new Float64Array(0)
  private stampX = new Uint32Array(0)
  private stampZ = new Uint32Array(0)
  private gen = 0

  constructor(b: WaterBuffers) {
    this.surface = new Int32Array(b.surface)
    this.flux = new Int16Array(b.flux)
    this.stamp = new Int32Array(b.stamp)
  }

  /**
   * Publishes `changed` (sorted tile indices) plus the previous publish's tiles; null when both are empty. With `layered`,
   * the tick also carries the tiles' layer records (records). The publisher
   * keeps `changed` (it is the next publish's previous tiles): the caller hands over a fresh array and never modifies it.
   */
  publish(changed: readonly number[], cols: WaterColumns, layered?: { under: UnderSegments; edges: WaterEdges; height: number }): WaterTick | null {
    const tiles = mergeTiles(changed, this.last)
    this.last = changed
    if (tiles.length === 0) return null
    const seq = ++this.seq, p = seq & 1, base = p * cols.n, T = cols.tiles, sx = cols.sx
    if (this.shown.length !== cols.n) this.shown = new Uint8Array(cols.n)
    const shown = this.shown, depth = cols.depth, floor = cols.floor, cflux = cols.flux, surface = this.surface, flux = this.flux
    // A full barrier, not just a release store: no data store below may become visible before the stamp reads −1.
    Atomics.exchange(this.stamp, p, -1)
    for (const t of tiles) {
      const x0 = (t % T.tx) * TILE, z0 = Math.floor(t / T.tx) * TILE
      for (let z = z0; z < z0 + TILE; z++) {
        // c walks the row in the columns, o in the parity buffer; moved and clamp16 inline.
        for (let c = x0 + z * sx, o = base + c, e = c + TILE; c < e; c++, o++) {
          const d = depth[c]!
          let on = shown[c]!
          if (d >= SHOW_DEPTH) on = shown[c] = 1
          else if (d < HIDE_DEPTH) on = shown[c] = 0
          const s = floor[c]! * SUB + (on === 1 && d < SHOW_DEPTH ? SHOW_DEPTH : d)
          surface[o] = d > 0 ? s : ~s
          const f0 = cflux[2 * c]!, f1 = cflux[2 * c + 1]!
          const m0 = f0 >= 0 ? f0 >> FLUX_FP : -((-f0) >> FLUX_FP) | 0, m1 = f1 >= 0 ? f1 >> FLUX_FP : -((-f1) >> FLUX_FP) | 0
          flux[2 * o] = m0 > 32767 ? 32767 : m0 < -32768 ? -32768 : m0
          flux[2 * o + 1] = m1 > 32767 ? 32767 : m1 < -32768 ? -32768 : m1
        }
      }
    }
    Atomics.store(this.stamp, p, seq)
    return { seq, parity: p, tiles, layers: layered ? this.records(tiles, cols, layered.under, layered.edges, layered.height) : null }
  }

  /**
   * The layer records of `tiles` (plan design notes: Publishing): per tile, a rank-0 record for each top whose links differ
   * from "the neighbour's top", and a record for each shown lower segment of rank 1 to RANKS − 1. Lower segments' shown
   * flags follow the top's hysteresis. Wet lower segments ranked past RANKS − 1 are counted in `hidden`.
   */
  private records(tiles: readonly number[], cols: WaterColumns, U: UnderSegments, E: WaterEdges, height: number): Int32Array {
    this.recN = 0
    const n = cols.n, T = cols.tiles, sx = cols.sx, sz = cols.sz
    const refs = n + U.col.length
    if (this.sumX.length < refs) {
      this.sumX = new Float64Array(refs); this.sumZ = new Float64Array(refs)
      this.stampX = new Uint32Array(refs); this.stampZ = new Uint32Array(refs)
    }
    for (const t of tiles) {
      const x0 = (t % T.tx) * TILE, z0 = Math.floor(t / T.tx) * TILE
      this.push(t)
      const at = this.recN
      this.push(0)
      // Records only come from a column with a lower segment or beside one: a tile with none in it or its ring has none.
      if (!this.anyLower(x0, z0, sx, sz, U)) {
        this.hidden -= this.hiddenOf.get(t) ?? 0
        this.hiddenOf.delete(t)
        continue
      }
      let count = 0, hidden = 0
      for (let z = z0; z < z0 + TILE; z++) for (let c = x0 + z * sx, e = c + TILE; c < e; c++) {
        for (let i = U.first[c]!; i >= 0; i = U.next[i]!) {
          const d = U.depth[i]!
          if (d >= SHOW_DEPTH) U.shown[i] = 1
          else if (d < HIDE_DEPTH) U.shown[i] = 0
        }
      }
      // Water moved last step through each segment's +x / +z sides, summed over its edges (the dense edge for a top).
      const gen = ++this.gen
      const L = E.tiles[t]
      if (L) for (let e = 0; e < L.count; e++) {
        const m = moved(L.flux[e]!), a = L.a[e]!
        if (L.axis[e] === 0) {
          if (this.stampX[a] === gen) this.sumX[a] = this.sumX[a]! + m
          else { this.stampX[a] = gen; this.sumX[a] = m }
        } else if (this.stampZ[a] === gen) this.sumZ[a] = this.sumZ[a]! + m
        else { this.stampZ[a] = gen; this.sumZ[a] = m }
      }
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) {
        const c = x + z * sx, local = (x - x0) + (z - z0) * TILE
        if ((U.first[c]! >= 0 || this.sideHasLower(x, z, sx, sz, U)) && this.record(c, 0, 0, cols.floor[c]!, height, c, x, z, local, cols, U, height)) count++
        // Lower segments bottom-up; the one at position j of k has rank k − j (the top is rank 0).
        let k = 0
        for (let i = U.first[c]!; i >= 0; i = U.next[i]!) k++
        let j = 0
        for (let i = U.first[c]!; i >= 0; i = U.next[i]!, j++) {
          const rank = k - j
          if (U.shown[i] !== 1) continue
          if (rank >= RANKS) { hidden++; continue }
          if (U.body[i]! >= 0 || U.depth[i]! >= U.cap(i)) continue // no free surface: its slot sinks away like a dried one
          const d = U.depth[i]!
          if (this.record(n + i, rank, U.floor[i]! * SUB + (d < SHOW_DEPTH ? SHOW_DEPTH : d), U.floor[i]!, U.ceil[i]!, c, x, z, local, cols, U, height)) count++
        }
      }
      this.rec[at] = count
      this.hidden += hidden - (this.hiddenOf.get(t) ?? 0)
      if (hidden > 0) this.hiddenOf.set(t, hidden)
      else this.hiddenOf.delete(t)
    }
    return this.rec.slice(0, this.recN)
  }

  /**
   * Pushes the record of segment ref r (rank, surface, floor, ceil) of column c at (x, z), tile-local `local`, and returns
   * true; a top whose four links are the default (0) has none (false). A side outside the world links 0.
   */
  private record(r: number, rank: number, surface: number, floor: number, ceil: number, c: number, x: number, z: number, local: number,
    cols: WaterColumns, U: UnderSegments, height: number): boolean {
    const n = cols.n, sx = cols.sx, sz = cols.sz
    const f = r < n ? cols.floor[r]! : U.floor[r - n]!, ce = r < n ? height : U.ceil[r - n]!
    const S = f * SUB + (r < n ? cols.depth[r]! : U.depth[r - n]!)
    const l0 = x + 1 < sx ? this.link(c, 0, cols, U, height, f, ce, S) : 0
    const l1 = x > 0 ? this.link(c, 1, cols, U, height, f, ce, S) : 0
    const l2 = z + 1 < sz ? this.link(c, 2, cols, U, height, f, ce, S) : 0
    const l3 = z > 0 ? this.link(c, 3, cols, U, height, f, ce, S) : 0
    if (rank === 0 && l0 === 0 && l1 === 0 && l2 === 0 && l3 === 0) return false
    const g = this.gen
    const fx = clamp16((r < n ? moved(cols.flux[2 * c]!) : 0) + (this.stampX[r] === g ? this.sumX[r]! : 0))
    const fz = clamp16((r < n ? moved(cols.flux[2 * c + 1]!) : 0) + (this.stampZ[r] === g ? this.sumZ[r]! : 0))
    this.push(local | (rank << 8))
    this.push(surface)
    this.push(floor | (ceil << 16))
    this.push((fx & 0xffff) | (fz << 16))
    this.push(l0 | (l1 << 16))
    this.push(l2 | (l3 << 16))
    return true
  }

  /**
   * The link on side dir of a segment of column c (floor f, ceiling ce, surface S in 1/SUB block), the neighbour lying in
   * the world (plan decision 13 of 3d). Among the neighbour's segments overlapping the run [f, ce):
   * - the one with the highest floor below S, else the lowest;
   * - its rank when it is a top or drawn (U.shown);
   * - LINK_GROUND | its floor when it is a dry lower one;
   * - LINK_WALL when none overlaps, when the one met ranks past RANKS − 1, when its ceiling is at or under S, or when it is a
   *   lower segment full to its ceiling or in a body (no free surface).
   * The neighbour's chain is walked once, bottom-up then its top, counting ranks on the way; on a tie the first met wins.
   * The golden publish hash (waterPublishGolden.test.ts) pins it to 3d's reference.
   */
  private link(c: number, dir: number, cols: WaterColumns, U: UnderSegments, height: number, f: number, ce: number, S: number): number {
    const n = cols.n, nc = c + SIDE_X[dir]! + SIDE_Z[dir]! * cols.sx
    let best = -1, bestF = -1, bestP = -1, low = -1, lowF = Infinity, lowP = -1, k = 0
    for (let i = U.first[nc]!; i >= 0; i = U.next[i]!, k++) {
      const rf = U.floor[i]!, rc = U.ceil[i]!
      if (rf >= ce || rc <= f || rf >= rc) continue
      if (rf * SUB < S && rf > bestF) { best = n + i; bestF = rf; bestP = k }
      if (rf < lowF) { low = n + i; lowF = rf; lowP = k }
    }
    const tf = cols.floor[nc]!
    if (!(tf >= ce || height <= f || tf >= height)) {
      if (tf * SUB < S && tf > bestF) { best = nc; bestF = tf; bestP = k }
      if (tf < lowF) { low = nc; lowF = tf; lowP = k }
    }
    const m = best >= 0 ? best : low
    if (m < 0) return LINK_WALL
    // k lower segments: the one at position p (bottom-up) has k − p segments from the top, itself included.
    const rank = m < n ? 0 : k - (best >= 0 ? bestP : lowP)
    if (rank >= RANKS) return LINK_WALL
    if (m < n) return height * SUB <= S ? LINK_WALL : 0
    const i = m - n
    if (U.ceil[i]! * SUB <= S || U.body[i]! >= 0 || U.depth[i]! >= U.cap(i)) return LINK_WALL
    return U.shown[i] === 1 ? rank : LINK_GROUND | U.floor[i]!
  }

  /** Whether a column of the tile at (x0, z0), or of the columns just outside its four sides, has a lower segment. */
  private anyLower(x0: number, z0: number, sx: number, sz: number, U: UnderSegments): boolean {
    const first = U.first
    for (let z = z0; z < z0 + TILE; z++) for (let c = x0 + z * sx, e = c + TILE; c < e; c++) if (first[c]! >= 0) return true
    for (let i = 0; i < TILE; i++) {
      if (x0 > 0 && first[x0 - 1 + (z0 + i) * sx]! >= 0) return true
      if (x0 + TILE < sx && first[x0 + TILE + (z0 + i) * sx]! >= 0) return true
      if (z0 > 0 && first[x0 + i + (z0 - 1) * sx]! >= 0) return true
      if (z0 + TILE < sz && first[x0 + i + (z0 + TILE) * sx]! >= 0) return true
    }
    return false
  }

  /** Whether a neighbour column of (x, z) has a lower segment: only then can a top's links differ from the default. */
  private sideHasLower(x: number, z: number, sx: number, sz: number, U: UnderSegments): boolean {
    const c = x + z * sx
    return (x > 0 && U.first[c - 1]! >= 0) || (x + 1 < sx && U.first[c + 1]! >= 0) || (z > 0 && U.first[c - sx]! >= 0) || (z + 1 < sz && U.first[c + sx]! >= 0)
  }

  private push(v: number): void {
    if (this.recN === this.rec.length) { const r = new Int32Array(this.rec.length * 2); r.set(this.rec); this.rec = r }
    this.rec[this.recN++] = v
  }
}
