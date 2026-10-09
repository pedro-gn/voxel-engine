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
 * The main thread's side of the water host (spec §4.1): one request in flight; everything queued behind it goes out as one
 * request right after its reply's copy, in tick order, with the alpha on screen then. So the host keeps up however few
 * round trips the main thread makes. No coalescing: publishes are deltas, and the host applies each one.
 * While a publish is in flight the drawn alpha is frozen at the one it was sent with (`frozen`).
 */
export class WaterLink {
  private readonly hooks: WaterLinkHooks
  private readonly queue: Entry[] = []
  private inFlight: { id: number; shown: number; entries: Entry[]; publishes: boolean } | null = null
  private nextId = 0
  private readonly depths = new Uint16Array(DEPTH_WINDOW)
  private depthAt = 0

  constructor(hooks: WaterLinkHooks) { this.hooks = hooks }

  /** Ticks in flight or queued. */
  get depth(): number { return this.queue.length + (this.inFlight ? this.inFlight.entries.length : 0) }

  /** The largest depth over the last DEPTH_WINDOW submits. */
  maxDepth(): number {
    let m = 0
    for (const d of this.depths) if (d > m) m = d
    return m
  }

  /** The alpha a publish in flight was sent with, to draw until its reply; null when no publish is in flight. */
  get frozen(): number | null { return this.inFlight !== null && this.inFlight.publishes ? this.inFlight.shown : null }

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

  /** The host's reply; one to a request from before reset() is ignored. Its entries' hooks run in tick order. */
  receive(reply: WaterReply): void {
    const f = this.inFlight
    if (f === null || reply.id !== f.id) return
    this.inFlight = null
    this.hooks.copy(reply, f.publishes)
    f.entries.forEach((e, i) => {
      if (reply.applied[i]) this.hooks.applied(e.tick, e.arrived)
      else if (e.water === null && e.settles) this.hooks.settled()
    })
    this.drain()
  }

  /** Forgets the request in flight and the queue (the worker was lost). */
  reset(): void {
    this.inFlight = null
    this.queue.length = 0
  }

  /**
   * Sends the whole queue as one request. Entries with nothing for the host at its head only release the clock, at once;
   * behind the first one with something, they go along, so their settles keep their place in tick order.
   */
  private drain(): void {
    if (this.inFlight !== null) return
    while (this.queue.length > 0 && this.queue[0]!.water === null && this.queue[0]!.relight.length === 0) {
      if (this.queue.shift()!.settles) this.hooks.settled()
    }
    if (this.queue.length === 0) return
    const entries = this.queue.splice(0), id = ++this.nextId, shown = this.hooks.shown()
    this.inFlight = { id, shown, entries, publishes: entries.some(e => e.water !== null) }
    this.hooks.post({ type: 'apply', id, shown, entries: entries.map(e => ({ tick: e.tick, water: e.water, relight: e.relight })) })
  }
}
