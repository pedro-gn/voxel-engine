interface Bucket { items: number[]; head: number }

/** Scheduled block updates. Deterministic: (due tick, insertion order). */
export class Scheduler {
  private readonly due = new Map<number, number>()
  private readonly buckets = new Map<number, Bucket>()
  private readonly ticks: number[] = [] // ascending distinct due ticks that have a bucket

  get size(): number { return this.due.size }

  schedule(pos: number, dueTick: number): void {
    const cur = this.due.get(pos)
    if (cur !== undefined && cur <= dueTick) return
    this.due.set(pos, dueTick)
    let b = this.buckets.get(dueTick)
    if (!b) {
      b = { items: [], head: 0 }
      this.buckets.set(dueTick, b)
      let i = this.ticks.length
      while (i > 0 && this.ticks[i - 1]! > dueTick) i--
      this.ticks.splice(i, 0, dueTick)
    }
    b.items.push(pos)
  }

  drain(tick: number, limit: number): number[] {
    const out: number[] = []
    while (out.length < limit && this.ticks.length > 0 && this.ticks[0]! <= tick) {
      const t = this.ticks[0]!
      const b = this.buckets.get(t)!
      while (out.length < limit && b.head < b.items.length) {
        const pos = b.items[b.head++]!
        if (this.due.get(pos) !== t) continue // stale: moved earlier or already run
        this.due.delete(pos)
        out.push(pos)
      }
      if (b.head >= b.items.length) {
        this.buckets.delete(t)
        this.ticks.shift()
      }
    }
    return out
  }
}
