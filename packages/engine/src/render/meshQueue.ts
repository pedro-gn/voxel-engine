export const PRIORITY = { GHOST: 0, DIRTY: 1, INITIAL: 2 } as const

/** Which chunk to mesh next. Pure bookkeeping: no workers, no three.js. */
export class MeshQueue {
  private readonly queued = new Map<number, number>()
  private readonly inFlight = new Map<number, number>()
  private readonly again = new Map<number, number>()
  private readonly applied = new Map<number, number>()

  get size(): number { return this.queued.size }
  get inFlightCount(): number { return this.inFlight.size }

  priorityOf(ci: number): number | undefined {
    return this.queued.get(ci) ?? this.again.get(ci) ?? this.inFlight.get(ci)
  }

  mark(ci: number, priority: number): void {
    if (this.inFlight.has(ci)) {
      const cur = this.again.get(ci)
      if (cur === undefined || priority < cur) this.again.set(ci, priority)
      return
    }
    const cur = this.queued.get(ci)
    if (cur === undefined || priority < cur) this.queued.set(ci, priority)
  }

  next(distance: (ci: number) => number): number {
    let best = -1, bestP = Infinity, bestD = Infinity
    for (const [ci, p] of this.queued) {
      if (p > bestP) continue
      const d = distance(ci)
      if (p < bestP || d < bestD) { best = ci; bestP = p; bestD = d }
    }
    if (best >= 0) {
      this.queued.delete(best)
      this.inFlight.set(best, bestP)
    }
    return best
  }

  finish(ci: number): void {
    this.inFlight.delete(ci)
    const p = this.again.get(ci)
    if (p !== undefined) {
      this.again.delete(ci)
      this.mark(ci, p)
    }
  }

  /** A job returned `retry` (snapshot failed): free its slot and queue the chunk again, never lower than before. */
  retry(ci: number): void {
    const p = this.inFlight.get(ci)
    this.finish(ci)
    if (p !== undefined) this.mark(ci, p)
  }

  /** The version of the mesh last applied for a chunk; −1 before any. */
  appliedVersion(ci: number): number { return this.applied.get(ci) ?? -1 }

  /** True if a result with this version may replace what is shown. Same version is allowed (ghost meshes). */
  accept(ci: number, version: number): boolean {
    const last = this.applied.get(ci)
    if (last !== undefined && version < last) return false
    this.applied.set(ci, version)
    return true
  }
}
