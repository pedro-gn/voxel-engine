import type { TerrainDoc, Vec2 } from '@elovox/terrain'
import { unionArea, type Area, type AreaRect } from './area.ts'
import type { ChangeEvent } from './session.ts'

/** What the preview drives; `engine.terrain` fits it. */
export interface TerrainTarget {
  setDocument(doc: unknown): Promise<void>
  regenerate(rect: AreaRect): Promise<{ ms: number; chunks: number }>
}

export type PreviewStatus =
  | { state: 'idle'; last: { ms: number; chunks: number; wallMs: number } | null }
  | { state: 'busy' }
  | { state: 'error'; message: string; opId: string | null }

export interface PreviewOptions {
  /** World x and z. */
  size: Vec2
  onStatus?(s: PreviewStatus): void
  /** Resolves when the regenerated chunks are visible (the mesh queue drained). Default: at once. */
  settle?(): Promise<void>
  now?(): number
}

/**
 * Keeps the world in step with the session. One regeneration runs at a time; changes that arrive
 * meanwhile merge into one pending area and the latest document, so the world always catches up to
 * the newest state without replaying the ones in between.
 */
export class PreviewScheduler {
  private readonly target: TerrainTarget
  private readonly o: PreviewOptions
  /** The document the engine has. */
  private sent: TerrainDoc
  private latest: TerrainDoc
  private pending: Area = null
  /** Areas whose regeneration failed: retried with the next one. */
  private failed: Area = null
  /** A whole-world change waits for its gesture to end. */
  private deferred = false
  private running: Promise<void> | null = null
  private generation = 0
  private current: PreviewStatus = { state: 'idle', last: null }

  constructor(target: TerrainTarget, initial: TerrainDoc, o: PreviewOptions) {
    this.target = target
    this.o = o
    this.sent = initial
    this.latest = initial
  }

  get status(): PreviewStatus { return this.current }

  /** Feeds a session change. */
  onChange(e: ChangeEvent): void {
    if (e.cause === 'gesture' && e.area === 'all') {
      this.deferred = true // a full regeneration takes seconds: wait for the release
      this.latest = e.doc
      return
    }
    if (e.cause === 'commit' || e.cause === 'cancel') {
      const deferred = this.deferred
      this.deferred = false
      if (e.cause === 'commit' && !deferred) return // an op gesture was previewed while it ran
      if (e.cause === 'cancel' && deferred) { this.latest = e.doc; return } // the world never left the start
    }
    this.push(e.doc, e.area)
  }

  /** Brings `area` of the world up to `doc`. */
  push(doc: TerrainDoc, area: Area): void {
    this.latest = doc
    if (area === null) return
    this.pending = unionArea(this.pending, area)
    this.kick()
  }

  /** Resolves once nothing is pending or running. */
  idle(): Promise<void> {
    return this.running ? this.running.then(() => this.idle()) : Promise.resolve()
  }

  private kick(): void {
    if (this.running || this.pending === null) return
    this.running = this.loop().finally(() => {
      this.running = null
      this.kick() // something may have arrived between the loop's last check and here
    })
  }

  private async loop(): Promise<void> {
    while (this.pending !== null) {
      const area = unionArea(this.pending, this.failed) as Exclude<Area, null>
      const doc = this.latest
      this.pending = null
      this.failed = null
      const gen = ++this.generation
      const t0 = this.now()
      this.setStatus({ state: 'busy' })
      try {
        if (doc !== this.sent) {
          await this.target.setDocument(doc)
          this.sent = doc
        }
        const r = await this.target.regenerate(this.rectOf(area))
        if (this.pending === null) void this.settle(gen, r, t0)
      } catch (e) {
        this.failed = unionArea(this.failed, area)
        const message = e instanceof Error ? e.message : String(e)
        this.setStatus({ state: 'error', message, opId: /op "([^"]+)"/.exec(message)?.[1] ?? null })
      }
    }
  }

  private async settle(gen: number, r: { ms: number; chunks: number }, t0: number): Promise<void> {
    await this.o.settle?.()
    if (gen !== this.generation || this.current.state === 'error') return // a newer regeneration owns the status
    this.setStatus({ state: 'idle', last: { ms: r.ms, chunks: r.chunks, wallMs: this.now() - t0 } })
  }

  private rectOf(area: Exclude<Area, null>): AreaRect {
    return area === 'all' ? { x0: 0, z0: 0, x1: this.o.size[0], z1: this.o.size[1] } : area
  }

  private now(): number { return this.o.now ? this.o.now() : performance.now() }

  private setStatus(s: PreviewStatus): void {
    this.current = s
    this.o.onStatus?.(s)
  }
}
