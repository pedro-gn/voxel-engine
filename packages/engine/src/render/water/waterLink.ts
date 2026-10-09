import type { WaterTick } from '../../sim/water/publish.ts'
import type { WaterReply, WaterRequest } from './waterHost.ts'

export interface WaterLinkHooks {
  /** Sends a request to the host: the worker, or an in-thread host that answers through receive() at once. */
  post(req: WaterRequest): void
  /** Copies a reply into the main thread's mirror; `publish`: the request carried a publish (the apply cost is recorded). */
  copy(reply: WaterReply, publish: boolean): void
  /** A publish was applied: its step starts on screen (engine: waterTick, waterShown 0, clock hold tick + 1, lag from `arrived`). */
  applied(tick: number, arrived: number): void
  /** A tick without a publish came through, in order: every tile settled (engine: clock.hold(null)). */
  settled(): void
  /** The water alpha on screen now (engine: waterShown). */
  shown(): number
}

interface Entry { tick: number; water: WaterTick | null; relight: number[]; settles: boolean; arrived: number }

/** Depths kept for maxDepth: one per submit. */
const DEPTH_WINDOW = 200

/**
 * The main thread's side of the water host (spec §4.1): one request in flight, the rest queued in tick order and sent right
 * after the previous reply's copy, with the alpha on screen then (0 after an apply). No coalescing: publishes are deltas.
 * While a publish is in flight the drawn alpha is frozen at the one it was sent with (`frozen`).
 */
export class WaterLink {
  private readonly hooks: WaterLinkHooks
  private readonly queue: Entry[] = []
  private inFlight: (Entry & { id: number; shown: number }) | null = null
  private nextId = 0
  private readonly depths = new Uint16Array(DEPTH_WINDOW)
  private depthAt = 0

  constructor(hooks: WaterLinkHooks) { this.hooks = hooks }

  /** Requests in flight or queued. */
  get depth(): number { return this.queue.length + (this.inFlight ? 1 : 0) }

  /** The largest depth over the last DEPTH_WINDOW submits. */
  maxDepth(): number {
    let m = 0
    for (const d of this.depths) if (d > m) m = d
    return m
  }

  /** The alpha a publish in flight was sent with, to draw until its reply; null when no publish is in flight. */
  get frozen(): number | null { return this.inFlight !== null && this.inFlight.water !== null ? this.inFlight.shown : null }

  /**
   * A tick's publish (null: none) and the light ranges to re-read after it. `settles`: a tick, whose missing publish releases
   * the clock; false for a regeneration's relight. `arrived`: when its message came (performance.now()).
   */
  submit(tick: number, water: WaterTick | null, relight: number[], settles: boolean, arrived: number): void {
    this.queue.push({ tick, water, relight, settles, arrived })
    this.depths[this.depthAt] = Math.min(0xffff, this.depth)
    this.depthAt = (this.depthAt + 1) % DEPTH_WINDOW
    if (this.inFlight === null) this.drain()
  }

  /** The host's reply; one to a request from before reset() is ignored. */
  receive(reply: WaterReply): void {
    const e = this.inFlight
    if (e === null || reply.id !== e.id) return
    this.inFlight = null
    this.hooks.copy(reply, e.water !== null)
    if (reply.applied) this.hooks.applied(e.tick, e.arrived)
    else if (e.water === null && e.settles) this.hooks.settled()
    this.drain()
  }

  /** Forgets the request in flight and the queue (the worker was lost). */
  reset(): void {
    this.inFlight = null
    this.queue.length = 0
  }

  /** Sends the queue's head; entries with nothing for the host only release the clock, in order. */
  private drain(): void {
    while (this.inFlight === null && this.queue.length > 0) {
      const e = this.queue.shift()!
      if (e.water === null && e.relight.length === 0) { if (e.settles) this.hooks.settled(); continue }
      const id = ++this.nextId, shown = this.hooks.shown()
      this.inFlight = { ...e, id, shown }
      this.hooks.post({ type: 'apply', id, tick: e.tick, water: e.water, shown, relight: e.relight })
    }
  }
}
