interface State { idle: number; queued: boolean }

/** Moving liquid cells: a deduplicated FIFO of voxel indices with an idle-step count each. */
export class ActiveQueue {
  private order: number[] = []
  private head = 0
  private readonly state = new Map<number, State>()

  get size(): number { return this.state.size }
  has(pos: number): boolean { return this.state.has(pos) }

  /** Activates a cell, or wakes an active one (its idle count drops to 0). */
  add(pos: number): void {
    const s = this.state.get(pos)
    if (s) {
      s.idle = 0
      if (!s.queued) { s.queued = true; this.order.push(pos) }
      return
    }
    this.state.set(pos, { idle: 0, queued: true })
    this.order.push(pos)
  }

  /** Takes up to n cells from the front, in order, into `out` (cleared first). They stay active: requeue() or drop() each one. */
  take(n: number, out: number[] = []): number[] {
    out.length = 0
    while (out.length < n && this.head < this.order.length) {
      const pos = this.order[this.head++]!
      const s = this.state.get(pos)
      if (!s || !s.queued) continue // dropped, or a stale duplicate
      s.queued = false
      out.push(pos)
    }
    if (this.head > 4096 && this.head * 2 > this.order.length) {
      this.order = this.order.slice(this.head)
      this.head = 0
    }
    return out
  }

  /** Puts a taken cell back at the end of the line. */
  requeue(pos: number): void {
    const s = this.state.get(pos)
    if (s && !s.queued) { s.queued = true; this.order.push(pos) }
  }

  drop(pos: number): void { this.state.delete(pos) }

  /** One more step without change; returns the new idle count. */
  rest(pos: number): number {
    const s = this.state.get(pos)
    if (!s) return 0
    s.idle++
    return s.idle
  }

  clear(): void {
    this.order = []
    this.head = 0
    this.state.clear()
  }

  mixState(mix: (v: number) => void): void {
    mix(this.state.size)
    for (let i = this.head; i < this.order.length; i++) {
      const pos = this.order[i]!
      const s = this.state.get(pos)
      if (s && s.queued) { mix(pos); mix(s.idle) }
    }
  }
}
