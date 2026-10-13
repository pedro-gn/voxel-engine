interface Entry { pos: number; seq: number }
interface DueEntry { tick: number; seq: number }
interface Bucket { items: Entry[]; head: number }

/** Scheduled block updates. Deterministic: (due tick, insertion order). */
export class Scheduler {
  private readonly due = new Map<number, DueEntry>()
  private readonly buckets = new Map<number, Bucket>()
  private readonly ticks: number[] = [] // ascending distinct due ticks that have a bucket
  private seq = 0 // monotonically increasing sequence number

  get size(): number { return this.due.size }

  schedule(pos: number, dueTick: number): void {
    const cur = this.due.get(pos)
    if (cur !== undefined && cur.tick <= dueTick) return
    this.seq++
    this.due.set(pos, { tick: dueTick, seq: this.seq })
    let b = this.buckets.get(dueTick)
    if (!b) {
      b = { items: [], head: 0 }
      this.buckets.set(dueTick, b)
      let i = this.ticks.length
      while (i > 0 && this.ticks[i - 1]! > dueTick) i--
      this.ticks.splice(i, 0, dueTick)
    }
    b.items.push({ pos, seq: this.seq })
  }

  /** Every pending update as [pos, due tick] pairs in drain order (due tick, then insertion), and the sequence counter. */
  entries(): { pairs: Int32Array; seq: number } {
    const all = [...this.due].sort((a, b) => a[1].tick - b[1].tick || a[1].seq - b[1].seq)
    const pairs = new Int32Array(all.length * 2)
    all.forEach(([pos, d], i) => { pairs[2 * i] = pos; pairs[2 * i + 1] = d.tick })
    return { pairs, seq: this.seq }
  }

  /** Replaces the queue with `pairs` (entries() order) and resumes the sequence at `seq`. */
  restore(pairs: Int32Array, seq: number): void {
    this.due.clear(); this.buckets.clear(); this.ticks.length = 0; this.seq = 0
    for (let i = 0; i < pairs.length; i += 2) this.schedule(pairs[i]!, pairs[i + 1]!)
    this.seq = seq
  }

  drain(tick: number, limit: number): number[] {
    const out: number[] = []
    while (out.length < limit && this.ticks.length > 0 && this.ticks[0]! <= tick) {
      const t = this.ticks[0]!
      const b = this.buckets.get(t)!
      while (out.length < limit && b.head < b.items.length) {
        const entry = b.items[b.head++]!
        const due = this.due.get(entry.pos)
        if (!due || due.tick !== t || due.seq !== entry.seq) continue // stale: moved earlier or already run
        this.due.delete(entry.pos)
        out.push(entry.pos)
      }
      if (b.head >= b.items.length) {
        this.buckets.delete(t)
        this.ticks.shift()
      }
    }
    return out
  }
}
