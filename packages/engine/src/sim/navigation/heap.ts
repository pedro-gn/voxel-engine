/** Lazy binary min-heap of integer ids ordered by (f, h, id); duplicates allowed, callers skip stale pops. */
export class IdHeap {
  private ids = new Float64Array(64)
  private fs = new Float64Array(64)
  private hs = new Float64Array(64)
  private n = 0
  get size(): number { return this.n }
  clear(): void { this.n = 0 }
  peekF(): number { return this.n ? this.fs[0]! : Infinity }
  private less(a: number, b: number): boolean {
    const fa = this.fs[a]!, fb = this.fs[b]!
    if (fa !== fb) return fa < fb
    const ha = this.hs[a]!, hb = this.hs[b]!
    return ha !== hb ? ha < hb : this.ids[a]! < this.ids[b]!
  }
  private swap(a: number, b: number): void {
    const { ids, fs, hs } = this
    let t = ids[a]!; ids[a] = ids[b]!; ids[b] = t
    t = fs[a]!; fs[a] = fs[b]!; fs[b] = t
    t = hs[a]!; hs[a] = hs[b]!; hs[b] = t
  }
  push(id: number, f: number, h: number): void {
    if (this.n === this.ids.length) {
      const grow = (old: Float64Array) => { const a = new Float64Array(old.length * 2); a.set(old); return a }
      this.ids = grow(this.ids); this.fs = grow(this.fs); this.hs = grow(this.hs)
    }
    let i = this.n++
    this.ids[i] = id; this.fs[i] = f; this.hs[i] = h
    while (i) { const p = (i - 1) >> 1; if (!this.less(i, p)) break; this.swap(i, p); i = p }
  }
  pop(): number {
    const id = this.ids[0]!
    if (--this.n) {
      this.ids[0] = this.ids[this.n]!; this.fs[0] = this.fs[this.n]!; this.hs[0] = this.hs[this.n]!
      let i = 0
      for (;;) {
        const l = i * 2 + 1, r = l + 1
        let m = i
        if (l < this.n && this.less(l, m)) m = l
        if (r < this.n && this.less(r, m)) m = r
        if (m === i) break
        this.swap(i, m); i = m
      }
    }
    return id
  }
  mixState(mix: (n: number) => void): void { mix(this.n); for (let i = 0; i < this.n; i++) { mix(this.ids[i]!); mix(this.fs[i]!); mix(this.hs[i]!) } }
}
