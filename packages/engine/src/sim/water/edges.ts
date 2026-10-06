import type { WaterColumns } from './columns.ts'
import { TILE } from './constants.ts'
import type { UnderSegments } from './under.ts'

/**
 * The under edges one tile owns (plan design notes: Edges). Edge e joins segment ref a, in a column of the tile, to ref b in
 * its +x (axis 0) or +z (axis 1) neighbour column; the two top segments' edge is the dense one (WaterColumns.flux).
 */
export class TileEdges {
  count = 0
  a = new Int32Array(8)
  b = new Int32Array(8)
  /** The opening's floor: max(floor a, floor b), in blocks. */
  lo = new Int16Array(8)
  axis = new Uint8Array(8)
  /** Stored flux (FLUX_FP extra bits; positive from a to b), as WaterColumns.flux. */
  flux = new Int32Array(8)
  /** The step that last collected the edge (WaterColumns.collectUnder). */
  seen = new Int32Array(8)

  push(a: number, b: number, lo: number, axis: number, flux: number): void {
    if (this.count === this.a.length) {
      const m = this.a.length * 2
      const g32 = (x: Int32Array) => { const y = new Int32Array(m); y.set(x); return y }
      this.a = g32(this.a); this.b = g32(this.b); this.flux = g32(this.flux); this.seen = g32(this.seen)
      const lo = new Int16Array(m); lo.set(this.lo); this.lo = lo
      const ax = new Uint8Array(m); ax.set(this.axis); this.axis = ax
    }
    const e = this.count++
    this.a[e] = a; this.b[e] = b; this.lo[e] = lo; this.axis[e] = axis; this.flux[e] = flux; this.seen[e] = 0
  }
}

/** Column c's segments bottom-up as refs (its lower chain, then its top: ref c), into `out` (cleared first). */
export function segmentsOf(c: number, under: UnderSegments, out: number[]): number[] {
  out.length = 0
  for (let i = under.first[c]!; i >= 0; i = under.next[i]!) out.push(under.n + i)
  out.push(c)
  return out
}

export function floorOf(ref: number, cols: WaterColumns, under: UnderSegments): number {
  return ref < cols.n ? cols.floor[ref]! : under.floor[ref - cols.n]!
}
/** The world's height for a top segment. */
export function ceilOf(ref: number, cols: WaterColumns, under: UnderSegments, height: number): number {
  return ref < cols.n ? height : under.ceil[ref - cols.n]!
}
export function depthOf(ref: number, cols: WaterColumns, under: UnderSegments): number {
  return ref < cols.n ? cols.depth[ref]! : under.depth[ref - cols.n]!
}
export function columnOf(ref: number, cols: WaterColumns, under: UnderSegments): number {
  return ref < cols.n ? ref : under.col[ref - cols.n]!
}

/** Every tile's under edges, rebuilt per tile when a segment of one of its columns (or of the column −x / −z of it) changes. */
export class WaterEdges {
  readonly tiles: (TileEdges | null)[]
  /** Tiles the last ensure() rebuilt, ascending: bodies with boundary edges there are rebuilt (bodies.ts). */
  readonly rebuilt: number[] = []
  private readonly flag: Uint8Array
  private pending: number[] = []
  private readonly sa: number[] = []
  private readonly sb: number[] = []
  private readonly keep = new Map<number, number>()

  constructor(tileCount: number) {
    this.tiles = new Array<TileEdges | null>(tileCount).fill(null)
    this.flag = new Uint8Array(tileCount)
  }

  /** A segment of column (x, z) changed: its tile and the tiles of its −x and −z neighbours rebuild at the next ensure(). */
  markColumn(x: number, z: number, cols: WaterColumns): void {
    const T = cols.tiles
    this.mark(T.of(x, z))
    if (x > 0) this.mark(T.of(x - 1, z))
    if (z > 0) this.mark(T.of(x, z - 1))
  }

  markAll(): void { for (let t = 0; t < this.tiles.length; t++) this.mark(t) }

  /** Rebuilds the marked tiles, ascending; lists them in `rebuilt`. */
  ensure(cols: WaterColumns, under: UnderSegments, height: number): void {
    this.rebuilt.length = 0
    if (this.pending.length === 0) return
    const p = this.pending.sort((a, b) => a - b)
    this.pending = []
    for (const t of p) { this.flag[t] = 0; this.rebuild(t, cols, under, height); this.rebuilt.push(t) }
  }

  mixState(mix: (v: number) => void): void {
    for (let t = 0; t < this.tiles.length; t++) {
      const E = this.tiles[t]
      if (!E) continue
      mix(t); mix(E.count)
      for (let e = 0; e < E.count; e++) { mix(E.a[e]!); mix(E.b[e]!); mix(E.lo[e]!); mix(E.axis[e]!); mix(E.flux[e]!) }
    }
  }

  private mark(t: number): void {
    if (this.flag[t] === 1) return
    this.flag[t] = 1
    this.pending.push(t)
  }

  private rebuild(t: number, cols: WaterColumns, under: UnderSegments, height: number): void {
    const old = this.tiles[t], keep = this.keep, sx = cols.sx, sz = cols.sz, tx = cols.tiles.tx
    keep.clear()
    if (old) for (let e = 0; e < old.count; e++) keep.set(old.a[e]! * 4294967296 + old.b[e]!, old.flux[e]!)
    const x0 = (t % tx) * TILE, z0 = Math.floor(t / tx) * TILE
    let E: TileEdges | null = null
    for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) {
      const c = x + z * sx
      for (let axis = 0; axis < 2; axis++) {
        if (axis === 0 ? x + 1 >= sx : z + 1 >= sz) continue
        const nb = axis === 0 ? c + 1 : c + sx
        if (under.first[c]! < 0 && under.first[nb]! < 0) continue // two tops only: the dense edge
        const sa = segmentsOf(c, under, this.sa), sb = segmentsOf(nb, under, this.sb)
        for (const ra of sa) {
          const fa = floorOf(ra, cols, under), ca = ceilOf(ra, cols, under, height)
          for (const rb of sb) {
            if (ra === c && rb === nb) continue
            const fb = floorOf(rb, cols, under), cb = ceilOf(rb, cols, under, height)
            const lo = fa > fb ? fa : fb, hi = ca < cb ? ca : cb
            if (lo >= hi) continue
            E ??= new TileEdges()
            E.push(ra, rb, lo, axis, keep.get(ra * 4294967296 + rb) ?? 0)
          }
        }
      }
    }
    this.tiles[t] = E
  }
}
