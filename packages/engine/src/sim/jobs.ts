import type { Layout } from '../world/layout.ts'

/** Reads the world for one region job and remembers the epoch of every chunk it read. */
export class JobReader {
  private readonly seen = new Map<number, number>()
  private readonly layout: Layout
  private readonly epochs: Uint32Array
  private readonly read: (x: number, y: number, z: number) => number
  constructor(layout: Layout, epochs: Uint32Array, read: (x: number, y: number, z: number) => number) {
    this.layout = layout
    this.epochs = epochs
    this.read = read
  }

  get(x: number, y: number, z: number): number {
    if (x >= 0 && y >= 0 && z >= 0 && x < this.layout.size[0] && y < this.layout.size[1] && z < this.layout.size[2]) {
      const ci = this.layout.chunkOf(x, y, z)
      if (!this.seen.has(ci)) this.seen.set(ci, this.epochs[ci]!)
    }
    return this.read(x, y, z)
  }

  /** True when a chunk this job read has been written since. */
  stale(): boolean {
    for (const [ci, e] of this.seen) if (this.epochs[ci] !== e) return true
    return false
  }

  reset(): void { this.seen.clear() }
}

/**
 * Incremental work over a region of the world (pool scans, resurfacing; collapse checks in 3b).
 * A job reads the world only through its JobReader and writes only in finish().
 */
export interface RegionJob {
  readonly kind: string
  readonly done: boolean
  /** Visits up to `budget` cells (Infinity = no limit) and returns how many it used. Sets `done` when finished. */
  step(r: JobReader, budget: number): number
  /** Applies the result. Runs in the tick the job finishes, right after its last step. */
  finish(): void
  /** Drops all progress: the world changed under a part already read. */
  reset(): void
  mixState(mix: (v: number) => void): void
}

/** A job restarted this many times runs to completion without a budget, so a busy area cannot starve it. */
export const MAX_RESTARTS = 3

interface Entry { job: RegionJob; reader: JobReader; restarts: number }

function hashKind(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}

/** Runs region jobs in start order under a per-tick count of visited cells. Deterministic: no clocks. */
export class JobRunner {
  private queue: Entry[] = []
  private readonly layout: Layout
  private readonly epochs: Uint32Array
  private readonly read: (x: number, y: number, z: number) => number
  constructor(layout: Layout, epochs: Uint32Array, read: (x: number, y: number, z: number) => number) {
    this.layout = layout
    this.epochs = epochs
    this.read = read
  }

  get size(): number { return this.queue.length }

  start(job: RegionJob): void {
    this.queue.push({ job, reader: new JobReader(this.layout, this.epochs, this.read), restarts: 0 })
  }

  /** One tick of work: the head job gets the budget first; a finished job hands the rest to the next. */
  run(cap: number): void {
    let budget = cap
    while (this.queue.length > 0) {
      const e = this.queue[0]!
      if (e.reader.stale()) { e.job.reset(); e.reader.reset(); e.restarts++ }
      const unbounded = e.restarts >= MAX_RESTARTS
      if (!unbounded && budget <= 0) return
      budget -= e.job.step(e.reader, unbounded ? Infinity : budget)
      if (!e.job.done) {
        if (unbounded) throw new Error(`region job "${e.job.kind}" did not finish with an unbounded budget`)
        return
      }
      this.queue.shift()
      e.job.finish()
    }
  }

  /** Runs every queued job to completion now, including jobs that finishing jobs start. */
  drain(): void {
    while (this.queue.length > 0) {
      const e = this.queue.shift()!
      if (e.reader.stale()) { e.job.reset(); e.reader.reset(); e.restarts++ }
      e.job.step(e.reader, Infinity)
      if (!e.job.done) throw new Error(`region job "${e.job.kind}" did not finish with an unbounded budget`)
      e.job.finish()
    }
  }

  /** Drops queued jobs that match, without finishing them. */
  cancel(pred: (job: RegionJob) => boolean): void {
    this.queue = this.queue.filter((e) => !pred(e.job))
  }

  mixState(mix: (v: number) => void): void {
    mix(this.queue.length)
    for (const e of this.queue) { mix(hashKind(e.job.kind)); mix(e.restarts); e.job.mixState(mix) }
  }
}
