import { RANKS, TILE } from '../../sim/water/constants.ts'
import { RECORD } from '../../sim/water/links.ts'
import { SUB } from '../../world/waterBuffers.ts'

const SLOTS = TILE * TILE * RANKS

/** One tile's slots, index local column × RANKS + rank. Rank 0 holds links only: its water is the dense view's. */
class TileSlots {
  readonly present = new Uint8Array(SLOTS)
  readonly named = new Uint8Array(SLOTS)
  readonly prev = new Int32Array(SLOTS)
  readonly cur = new Int32Array(SLOTS)
  readonly floor = new Int16Array(SLOTS)
  readonly ceil = new Int16Array(SLOTS)
  readonly fluxX = new Int16Array(SLOTS)
  readonly fluxZ = new Int16Array(SLOTS)
  readonly links = new Uint16Array(SLOTS * 4)
}

/**
 * The main thread's slots of ranks 0–3 (plan design notes: The main thread): staged from each tick's layer records and
 * committed when SurfaceView reads their tile, so a slot moves from step to step like the dense columns. A slot no longer
 * published sinks to its floor over one step, then goes.
 */
export class LayerStore {
  readonly sx: number
  readonly sz: number
  readonly tx: number
  readonly tz: number
  private readonly tiles: (TileSlots | null)[]
  private readonly staged = new Map<number, Int32Array>()

  constructor(sx: number, sz: number) {
    this.sx = sx
    this.sz = sz
    this.tx = sx / TILE
    this.tz = sz / TILE
    this.tiles = new Array<TileSlots | null>(this.tx * this.tz).fill(null)
  }

  /** Keeps each tile's latest records from a tick's layers (tile blocks: tile, count, count × RECORD ints). */
  stage(layers: Int32Array): void {
    for (let o = 0; o < layers.length;) {
      const t = layers[o]!, count = layers[o + 1]!
      this.staged.set(t, layers.slice(o + 2, o + 2 + count * RECORD))
      o += 2 + count * RECORD
    }
  }

  /**
   * Applies tile t's staged records, if any. `first`: the tile is read for the first time (its slots start where they are).
   * `prev` / `cur`: the dense (rank 0) encoded surfaces of the previous and current step, as SurfaceView holds them. Water
   * that only changes layer keeps its level: a new slot whose run holds the column's previous rank-0 water (a block placed
   * over a lake: the lake is now a lower run) starts at that water, not at its floor; a slot no longer named whose run holds
   * the current rank-0 water (the block removed again) goes at once and hands its level to rank 0 (`prev` is written).
   * Returns whether a slot changed.
   */
  commit(t: number, first: boolean, prev?: Int32Array, cur?: Int32Array): boolean {
    const recs = this.staged.get(t)
    if (recs === undefined) return false
    this.staged.delete(t)
    let s = this.tiles[t]
    if (!s) {
      if (recs.length === 0) return false
      s = new TileSlots()
      this.tiles[t] = s
    }
    s.named.fill(0)
    let changed = false
    for (let o = 0; o < recs.length; o += RECORD) {
      const head: number = recs[o]!, r = head >> 8, k = (head & 0xff) * RANKS + r, lk = k * 4
      const l0 = recs[o + 4]! & 0xffff, l1 = recs[o + 4]! >>> 16, l2 = recs[o + 5]! & 0xffff, l3 = recs[o + 5]! >>> 16
      const L = s.links
      if (s.present[k] === 0 || L[lk] !== l0 || L[lk + 1] !== l1 || L[lk + 2] !== l2 || L[lk + 3] !== l3) changed = true
      L[lk] = l0; L[lk + 1] = l1; L[lk + 2] = l2; L[lk + 3] = l3
      if (r > 0) {
        const v = recs[o + 1]!, fl = recs[o + 2]! & 0xffff, ce = recs[o + 2]! >>> 16
        const fx = (recs[o + 3]! << 16) >> 16, fz = recs[o + 3]! >> 16
        const dv = prev ? prev[this.column(t, head & 0xff)]! : -1
        const pv = first ? v : s.present[k] === 1 ? s.cur[k]! : dv >= fl * SUB && dv <= ce * SUB ? dv : ~(fl * SUB)
        if (s.present[k] === 0 || s.cur[k] !== v || s.prev[k] !== pv || s.fluxX[k] !== fx || s.fluxZ[k] !== fz || s.floor[k] !== fl || s.ceil[k] !== ce) changed = true
        s.prev[k] = pv; s.cur[k] = v; s.floor[k] = fl; s.ceil[k] = ce; s.fluxX[k] = fx; s.fluxZ[k] = fz
      }
      s.present[k] = 1
      s.named[k] = 1
    }
    for (let k = 0; k < SLOTS; k++) {
      if (s.present[k] === 0 || s.named[k] === 1) continue
      changed = true
      if (k % RANKS === 0) { s.present[k] = 0; continue } // a top back to default links
      if (cur) {
        const c = this.column(t, (k / RANKS) | 0), dc = cur[c]!
        if (dc >= s.floor[k]! * SUB && dc <= s.ceil[k]! * SUB) { // its water is the top's again
          if (prev && s.cur[k]! >= 0) prev[c] = s.cur[k]!
          s.present[k] = 0
          continue
        }
      }
      const dry = ~(s.floor[k]! * SUB)
      if (s.cur[k] === dry && s.prev[k] === dry) { s.present[k] = 0; continue }
      s.prev[k] = s.cur[k]!
      s.cur[k] = dry
      s.fluxX[k] = 0
      s.fluxZ[k] = 0
    }
    return changed
  }

  /** The column index of local column `local` (x + z × 16) of tile t. */
  private column(t: number, local: number): number {
    const tx = t % this.tx, tz = (t - tx) / this.tx
    return tx * 16 + (local & 15) + (tz * 16 + (local >> 4)) * this.sx
  }

  /** Whether tile t ever held a slot (it then stays on the layered refresh path). */
  layered(t: number): boolean { return this.tiles[t] !== null }

  /** Whether tile t or one of its 8 neighbours ever held a slot. */
  layeredAround(t: number): boolean {
    const x = t % this.tx, z = (t - x) / this.tx
    for (let j = Math.max(0, z - 1); j <= Math.min(this.tz - 1, z + 1); j++) {
      for (let i = Math.max(0, x - 1); i <= Math.min(this.tx - 1, x + 1); i++) if (this.tiles[i + j * this.tx] !== null) return true
    }
    return false
  }

  has(c: number, r: number): boolean { const s = this.slots(c); return s !== null && s.present[this.k(c, r)] === 1 }
  prev(c: number, r: number): number { return this.slots(c)!.prev[this.k(c, r)]! }
  cur(c: number, r: number): number { return this.slots(c)!.cur[this.k(c, r)]! }
  floor(c: number, r: number): number { return this.slots(c)!.floor[this.k(c, r)]! }
  ceil(c: number, r: number): number { return this.slots(c)!.ceil[this.k(c, r)]! }
  fluxX(c: number, r: number): number { return this.slots(c)!.fluxX[this.k(c, r)]! }
  fluxZ(c: number, r: number): number { return this.slots(c)!.fluxZ[this.k(c, r)]! }

  /** Link of slot (c, r) on side dir: 0 (the neighbour's top) when the slot has no record. */
  link(c: number, r: number, dir: number): number {
    const s = this.slots(c), k = this.k(c, r)
    return s !== null && s.present[k] === 1 ? s.links[k * 4 + dir]! : 0
  }

  private slots(c: number): TileSlots | null {
    const x = c % this.sx, z = (c - x) / this.sx
    return this.tiles[(x >> 4) + (z >> 4) * this.tx]!
  }

  private k(c: number, r: number): number {
    const x = c % this.sx, z = (c - x) / this.sx
    return ((x & 15) + (z & 15) * 16) * RANKS + r
  }
}
