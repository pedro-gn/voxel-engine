/** One tick of the ring: a slot whose tick is not the asked one reads as empty. */
interface Slot { tick: number; cells: Map<number, number> }
interface Span { t: number; cells: number[] }

/**
 * Space-time reservations: (cell, tick) → owner over a rolling window, plus untimed holds for bodies standing still.
 * Timed entries are accepted for now <= t < now + 2 * window; the first owner of a (cell, tick) keeps it.
 */
export class ReservationTable {
  readonly window: number
  private at = 0
  private readonly slots: Slot[]
  /** Per owner, its timed entries sorted by tick. */
  private spans = new Map<number, Span[]>()
  private holds = new Map<number, number>()
  private held = new Map<number, number[]>()
  private timed = 0
  constructor(window = 32) {
    if (!Number.isSafeInteger(window) || window < 1) throw new RangeError('reservation window must be a positive integer')
    this.window = window
    this.slots = Array.from({ length: 2 * window }, () => ({ tick: -1, cells: new Map() }))
  }
  get now(): number { return this.at }
  get size(): number { return this.timed + this.holds.size }
  private slot(t: number): Slot | undefined {
    if (t < this.at || t >= this.at + 2 * this.window) return undefined
    const s = this.slots[t % (2 * this.window)]!
    return s.tick === t ? s : undefined
  }
  /** Owner of `cell` at absolute tick `t`: a hold wins over timed entries; 0 when free. */
  owner(cell: number, t: number): number { return this.holds.get(cell) ?? this.slot(t)?.cells.get(cell) ?? 0 }
  /** Whether no other owner holds any of the cells or has them at tick t. */
  free(owner: number, t: number, cells: readonly number[]): boolean {
    const s = this.slot(t)
    for (const c of cells) {
      const h = this.holds.get(c); if (h !== undefined && h !== owner) return false
      const o = s?.cells.get(c); if (o !== undefined && o !== owner) return false
    }
    return true
  }
  /** Timed: only for now <= t < now + 2 * window; earlier or later ticks are ignored. Cells another owner has at t are skipped. */
  reserve(owner: number, t: number, cells: readonly number[]): void {
    if (t < this.at || t >= this.at + 2 * this.window) return
    const s = this.slots[t % (2 * this.window)]!
    if (s.tick !== t) { this.timed -= s.cells.size; s.tick = t; s.cells.clear() }
    const taken: number[] = []
    for (const c of cells) { if (s.cells.has(c)) continue; s.cells.set(c, owner); taken.push(c); this.timed++ }
    if (!taken.length) return
    let list = this.spans.get(owner)
    if (!list) { list = []; this.spans.set(owner, list) }
    let i = list.length
    while (i > 0 && list[i - 1]!.t > t) i--
    if (i > 0 && list[i - 1]!.t === t) list[i - 1]!.cells.push(...taken)
    else list.splice(i, 0, { t, cells: taken })
  }
  private drop(owner: number, span: Span): void {
    const s = this.slot(span.t)
    if (!s) return
    for (const c of span.cells) if (s.cells.get(c) === owner) { s.cells.delete(c); this.timed-- }
  }
  /** Drops the owner's timed entries at ticks >= t. */
  releaseFrom(owner: number, t: number): void {
    const list = this.spans.get(owner)
    if (!list) return
    let i = list.length
    while (i > 0 && list[i - 1]!.t >= t) this.drop(owner, list[--i]!)
    list.length = i
    if (!i) this.spans.delete(owner)
  }
  /** Replaces the owner's hold with `cells`; cells another owner holds are skipped. */
  hold(owner: number, cells: readonly number[]): void {
    this.releaseHold(owner)
    const mine: number[] = []
    for (const c of cells) if (!this.holds.has(c)) { this.holds.set(c, owner); mine.push(c) }
    if (mine.length) this.held.set(owner, mine)
  }
  /** The cells the owner holds, in the order it asked for them. */
  heldBy(owner: number): readonly number[] { return this.held.get(owner) ?? [] }
  releaseHold(owner: number): void {
    for (const c of this.held.get(owner) ?? []) if (this.holds.get(c) === owner) this.holds.delete(c)
    this.held.delete(owner)
  }
  releaseOwner(owner: number): void { this.releaseFrom(owner, -Infinity); this.releaseHold(owner) }
  /** Owners other than `except` with timed entries on any of the cells at ticks >= from, ascending. */
  timedOwners(cells: readonly number[], from: number, except: number): number[] {
    const found = new Set<number>()
    for (let t = Math.max(from, this.at); t < this.at + 2 * this.window; t++) {
      const s = this.slot(t)
      if (s) for (const c of cells) { const o = s.cells.get(c); if (o !== undefined && o !== except) found.add(o) }
    }
    return [...found].sort((a, b) => a - b)
  }
  /** Last tick the owner has timed entries for, or now - 1. */
  horizon(owner: number): number { return this.spans.get(owner)?.at(-1)?.t ?? this.at - 1 }
  /** Moves the window to start at `now`, dropping every timed entry before it. */
  advance(now: number): void {
    if (now <= this.at) return
    const last = Math.min(now, this.at + 2 * this.window)
    for (let t = this.at; t < last; t++) { const s = this.slots[t % (2 * this.window)]!; if (s.tick === t) { this.timed -= s.cells.size; s.cells.clear(); s.tick = -1 } }
    this.at = now
    for (const [owner, list] of this.spans) {
      let i = 0
      while (i < list.length && list[i]!.t < now) i++
      if (i === list.length) this.spans.delete(owner); else if (i) list.splice(0, i)
    }
  }
  mixState(mix: (n: number) => void): void {
    mix(this.at); mix(this.window)
    mix(this.holds.size)
    for (const [c, o] of [...this.holds].sort((a, b) => a[0] - b[0])) { mix(c); mix(o) }
    for (let t = this.at; t < this.at + 2 * this.window; t++) {
      const s = this.slot(t)
      if (!s) { mix(0); continue }
      mix(s.cells.size)
      for (const [c, o] of [...s.cells].sort((a, b) => a[0] - b[0])) { mix(c); mix(o) }
    }
  }
}
