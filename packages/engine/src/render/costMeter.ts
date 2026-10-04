/** A running cost on the main thread (ms): its last sample and the p95 of the last `window` samples. */
export class CostMeter {
  private readonly samples: Float64Array
  private readonly sorted: Float64Array
  private next = 0
  /** Samples kept (at most the window). */
  count = 0
  /** The last sample (ms), 0 before any. */
  last = 0

  constructor(window: number) {
    this.samples = new Float64Array(window)
    this.sorted = new Float64Array(window)
  }

  record(ms: number): void {
    this.last = ms
    this.samples[this.next] = ms
    this.next = (this.next + 1) % this.samples.length
    if (this.count < this.samples.length) this.count++
  }

  /** The sample at rank floor(count × 0.95) of the kept samples, 0 before any. Sorts a copy: call it at HUD rate, not per sample. */
  p95(): number {
    if (this.count === 0) return 0
    const s = this.sorted.subarray(0, this.count)
    s.set(this.samples.subarray(0, this.count))
    s.sort()
    return s[Math.min(this.count - 1, Math.floor(this.count * 0.95))]!
  }
}
