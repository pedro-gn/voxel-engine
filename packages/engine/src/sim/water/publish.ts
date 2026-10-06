import type { WaterBuffers } from '../../world/waterBuffers.ts'
import { moved, type WaterColumns } from './columns.ts'
import { RANKS, SUB, TILE } from './constants.ts'
import type { WaterEdges } from './edges.ts'
import { linkOf } from './links.ts'
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
  private readonly segs: number[] = []
  private readonly chain: number[] = []
  private readonly fx = new Map<number, number>()
  private readonly fz = new Map<number, number>()

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
    const shown = this.shown
    // A full barrier, not just a release store: no data store below may become visible before the stamp reads −1.
    Atomics.exchange(this.stamp, p, -1)
    for (const t of tiles) {
      const x0 = (t % T.tx) * TILE, z0 = Math.floor(t / T.tx) * TILE
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) {
        const c = x + z * sx, d = cols.depth[c]!
        if (d >= SHOW_DEPTH) shown[c] = 1
        else if (d < HIDE_DEPTH) shown[c] = 0
        const s = cols.floor[c]! * SUB + (shown[c] === 1 && d < SHOW_DEPTH ? SHOW_DEPTH : d)
        this.surface[base + c] = d > 0 ? s : ~s
        this.flux[2 * (base + c)] = clamp16(moved(cols.flux[2 * c]!))
        this.flux[2 * (base + c) + 1] = clamp16(moved(cols.flux[2 * c + 1]!))
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
    const shown = (r: number) => (r < n ? this.shown[r] === 1 : U.shown[r - n] === 1)
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
      this.fx.clear(); this.fz.clear()
      const L = E.tiles[t]
      if (L) for (let e = 0; e < L.count; e++) {
        const m = moved(L.flux[e]!), a = L.a[e]!, map = L.axis[e] === 0 ? this.fx : this.fz
        map.set(a, (map.get(a) ?? 0) + m)
      }
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) {
        const c = x + z * sx, local = (x - x0) + (z - z0) * TILE
        const fx = (r: number) => clamp16((r < n ? moved(cols.flux[2 * c]!) : 0) + (this.fx.get(r) ?? 0))
        const fz = (r: number) => clamp16((r < n ? moved(cols.flux[2 * c + 1]!) : 0) + (this.fz.get(r) ?? 0))
        const link = (r: number, dir: number) => {
          const nx = x + (dir === 0 ? 1 : dir === 1 ? -1 : 0), nz = z + (dir === 2 ? 1 : dir === 3 ? -1 : 0)
          return nx < 0 || nz < 0 || nx >= sx || nz >= sz ? 0 : linkOf(r, c, dir, cols, U, height, shown, this.segs)
        }
        const record = (r: number, rank: number, surface: number, floor: number, ceil: number) => {
          const l0 = link(r, 0), l1 = link(r, 1), l2 = link(r, 2), l3 = link(r, 3)
          if (rank === 0 && l0 === 0 && l1 === 0 && l2 === 0 && l3 === 0) return
          this.push(local | (rank << 8))
          this.push(surface)
          this.push(floor | (ceil << 16))
          this.push((fx(r) & 0xffff) | (fz(r) << 16))
          this.push(l0 | (l1 << 16))
          this.push(l2 | (l3 << 16))
          count++
        }
        if (U.first[c]! >= 0 || this.sideHasLower(x, z, sx, sz, U)) record(c, 0, 0, cols.floor[c]!, height)
        const chain = U.chain(c, this.chain), k = chain.length
        for (let j = 0; j < k; j++) {
          const i = chain[j]!, rank = k - j
          if (U.shown[i] !== 1) continue
          if (rank >= RANKS) { hidden++; continue }
          const d = U.depth[i]!
          record(n + i, rank, U.floor[i]! * SUB + (d < SHOW_DEPTH ? SHOW_DEPTH : d), U.floor[i]!, U.ceil[i]!)
        }
      }
      this.rec[at] = count
      this.hidden += hidden - (this.hiddenOf.get(t) ?? 0)
      if (hidden > 0) this.hiddenOf.set(t, hidden)
      else this.hiddenOf.delete(t)
    }
    return this.rec.slice(0, this.recN)
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
