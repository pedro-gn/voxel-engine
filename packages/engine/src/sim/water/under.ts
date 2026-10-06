import { SUB } from './constants.ts'

/**
 * The lower segments of every column (3d spec §3; plan design notes: Segments): each run of air or water cells between two
 * walls below a column's top segment. The top segment is 3c's column (WaterColumns). A lower segment's ref is n + its index,
 * a top segment's ref is its column, so one number names any segment. Indices come from a free list, last freed first:
 * two worlds fed the same edits allocate the same indices. Nothing iterates by index: loops walk columns, then each
 * column's chain bottom-up.
 */
export class UnderSegments {
  readonly n: number
  /** Per column: its lowest lower segment, −1 when it has none. */
  readonly first: Int32Array
  floor = new Int16Array(0)
  ceil = new Int16Array(0)
  depth = new Int32Array(0)
  /** Depth after the segment's last step (the quiet test). */
  last = new Int32Array(0)
  /** Water beyond its capacity that an edit pushed in, until a body pushes it out (plan decision 9). */
  excess = new Int32Array(0)
  /** The segment's column, −1 for a free index. */
  col = new Int32Array(0)
  /** The next lower segment up the column; −1: the top segment is next. */
  next = new Int32Array(0)
  /** Its body (bodies.ts), −1 when free. */
  body = new Int32Array(0)
  /** 1 while it is drawn (publish hysteresis, as WaterPublisher's shown). */
  shown = new Uint8Array(0)
  /** The mirror's state for the segment (mirror.ts mirrorRun). */
  mirrorLo = new Int16Array(0)
  mirrorQ = new Int32Array(0)
  /** Lower segments in use. */
  count = 0
  private readonly freed: number[] = []
  private used = 0

  constructor(n: number) {
    this.n = n
    this.first = new Int32Array(n).fill(-1)
    this.grow(64)
  }

  cap(i: number): number { return (this.ceil[i]! - this.floor[i]!) * SUB }
  surface(i: number): number { return this.floor[i]! * SUB + this.depth[i]! }

  /** A new segment of column c, not yet in its chain (setChain). Its mirror is rewritten at the next flush. */
  alloc(c: number, floor: number, ceil: number, depth: number): number {
    let i = this.freed.pop()
    if (i === undefined) {
      if (this.used === this.col.length) this.grow(this.col.length * 2)
      i = this.used++
    }
    this.col[i] = c
    this.floor[i] = floor
    this.ceil[i] = ceil
    this.depth[i] = depth
    this.last[i] = depth
    this.excess[i] = 0
    this.next[i] = -1
    this.body[i] = -1
    this.shown[i] = 0
    this.mirrorLo[i] = floor
    this.mirrorQ[i] = ~(ceil * 8)
    this.count++
    return i
  }

  /** Frees index i (out of its column's chain already, or the chain is reset right after). */
  release(i: number): void {
    this.col[i] = -1
    this.next[i] = -1
    this.body[i] = -1
    this.freed.push(i)
    this.count--
  }

  /** Column c's lower segments bottom-up, into `out` (cleared first). */
  chain(c: number, out: number[]): number[] {
    out.length = 0
    for (let i = this.first[c]!; i >= 0; i = this.next[i]!) out.push(i)
    return out
  }

  /** Makes `list` (bottom-up) column c's chain. */
  setChain(c: number, list: readonly number[]): void {
    this.first[c] = list.length > 0 ? list[0]! : -1
    for (let k = 0; k < list.length; k++) this.next[list[k]!] = k + 1 < list.length ? list[k + 1]! : -1
  }

  /** Frees every lower segment of column c, bottom-up (their indices into `freed` when given). */
  freeColumn(c: number, freed?: number[]): void {
    let i = this.first[c]!
    while (i >= 0) {
      const nx = this.next[i]!
      freed?.push(i)
      this.release(i)
      i = nx
    }
    this.first[c] = -1
  }

  /** Rank from the top: 1 for the highest lower segment of its column, the top segment being 0. */
  rankOf(i: number): number {
    let r = 1
    for (let j = this.next[i]!; j >= 0; j = this.next[j]!) r++
    return r
  }

  /** Σ depth + excess over the segments in use. */
  total(): number {
    let s = 0
    for (let c = 0; c < this.n; c++) for (let i = this.first[c]!; i >= 0; i = this.next[i]!) s += this.depth[i]! + this.excess[i]!
    return s
  }

  /** Mixes every column's chain bottom-up (never by index): floor, ceil, depth, last, excess and the mirror's state. */
  mixState(mix: (v: number) => void): void {
    mix(this.count)
    for (let c = 0; c < this.n; c++) {
      for (let i = this.first[c]!; i >= 0; i = this.next[i]!) {
        mix(c); mix(this.floor[i]!); mix(this.ceil[i]!); mix(this.depth[i]!); mix(this.last[i]!); mix(this.excess[i]!)
        mix(this.mirrorLo[i]!); mix(this.mirrorQ[i]!)
      }
    }
  }

  private grow(cap: number): void {
    const g16 = (a: Int16Array) => { const b = new Int16Array(cap); b.set(a); return b }
    const g32 = (a: Int32Array, fill = 0) => { const b = new Int32Array(cap).fill(fill); b.set(a); return b }
    const g8 = (a: Uint8Array) => { const b = new Uint8Array(cap); b.set(a); return b }
    this.floor = g16(this.floor)
    this.ceil = g16(this.ceil)
    this.depth = g32(this.depth)
    this.last = g32(this.last)
    this.excess = g32(this.excess)
    this.col = g32(this.col, -1)
    this.next = g32(this.next, -1)
    this.body = g32(this.body, -1)
    this.shown = g8(this.shown)
    this.mirrorLo = g16(this.mirrorLo)
    this.mirrorQ = g32(this.mirrorQ)
  }
}
