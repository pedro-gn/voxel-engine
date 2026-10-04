/** How much faster or slower than real time the clock may run while it follows the latency estimate. */
const SLEW = 0.1
/** The same when the clock lags the estimate by more than a tick (after a hitch): catch up faster. */
const FAST_SLEW = 0.5
/** The latency estimate is the slowest arrival of this window (ms), so a single hitch is forgotten after it. */
export const WINDOW = 500
/** A latency change beyond this many ticks restarts the estimate from the new arrival. */
export const RESYNC = 4

/**
 * The smoothed sim clock everything drawn between sim ticks follows (falling cubes, the water surface; spec §5 "shared
 * clock"), instead of message arrival times, whose jitter would make motion hitch.
 *
 * Tick `t` is due at render time `t × tickMs + offset`, where `offset` follows the slowest arrival latency
 * (arrival − t × tickMs) of the last WINDOW ms, slewed at most SLEW (FAST_SLEW when far behind) so the drawn speed never
 * jumps. Each user that draws on the clock holds it up to a limit (the furthest tick it has data for): a late message holds
 * the clock there, nothing is extrapolated, and the clock is pushed back by the wait. While nobody holds it, the clock
 * snaps to the estimate (nothing on screen would show the jump).
 */
export class SimClock {
  readonly tickMs: number
  /** Arrivals of the last WINDOW ms: (time, arrival − tick × tickMs). */
  private readonly arrivals: { at: number; s: number }[] = []
  /** Their maximum: the latency the clock aims for. */
  private latency = Number.NaN
  /** The clock's latency term; follows `latency` at a limited rate. */
  private offset = Number.NaN
  private frameAt = 0
  private shown = Number.NEGATIVE_INFINITY
  private readonly holds = new Map<object, number>()
  /** The newest sim tick received. */
  newest = Number.NEGATIVE_INFINITY

  /** `tickMs`: the sim's nominal tick length. */
  constructor(tickMs: number) { this.tickMs = tickMs }

  /** The (fractional) tick the last `advance` showed. */
  get due(): number { return this.shown }

  /** Whether something is drawn on the clock (someone holds it). */
  get held(): boolean { return this.holds.size > 0 }

  /** Whether no frame ran in the WINDOW ms before `now` (a background tab). */
  idle(now: number): boolean { return now - this.frameAt > WINDOW }

  /** `who` draws on the clock with data up to sim tick `limit` at most; null: it draws nothing now. */
  hold(who: object, limit: number | null): void {
    if (limit === null) this.holds.delete(who)
    else this.holds.set(who, limit)
  }

  /** The message of sim tick `tick` arrived at `now` (ms). */
  arrive(tick: number, now: number): void {
    const s = now - tick * this.tickMs
    if (Number.isNaN(this.latency) || Math.abs(s - this.latency) > RESYNC * this.tickMs) {
      // A first arrival, or the sim paused or the page stalled: start the estimate over. With something drawn the clock
      // keeps its offset (a hold or the slew absorbs the change), so what is drawn never runs back.
      this.arrivals.length = 0
      if (this.holds.size === 0 || Number.isNaN(this.offset)) this.offset = s
    }
    this.arrivals.push({ at: now, s })
    while (this.arrivals[0]!.at < now - WINDOW) this.arrivals.shift()
    this.latency = Math.max(...this.arrivals.map((a) => a.s))
    this.newest = Math.max(this.newest, tick)
  }

  /**
   * Moves the clock to `now` (ms) and returns the (fractional) sim tick due then, held at the lowest limit of its holders.
   * Run it once per frame; advancing again at the same `now` changes nothing.
   */
  advance(now: number): number {
    const target = this.latency
    if (this.holds.size === 0 || Number.isNaN(this.offset)) this.offset = target
    else {
      const rate = this.offset - target > this.tickMs ? FAST_SLEW : SLEW
      const step = rate * Math.max(0, now - this.frameAt)
      this.offset += Math.min(step, Math.max(-step, target - this.offset))
    }
    this.frameAt = now
    let due = (now - this.offset) / this.tickMs
    let limit = Number.POSITIVE_INFINITY
    for (const l of this.holds.values()) if (l < limit) limit = l
    if (due > limit) {
      // The next message is late: hold at the limit and push the clock back by the wait, so what is drawn goes on from
      // here when it comes instead of catching up in a jump.
      due = limit
      this.offset = now - limit * this.tickMs
    }
    this.shown = due
    return due
  }
}

/**
 * How far (0–1) the clock at `due` is through the water step published at sim tick `tick` (the water's waterAlpha): the
 * surface leaves the previous step when `tick` is due and reaches the published one a tick later, as the next comes in.
 */
export function stepAlpha(due: number, tick: number): number {
  const a = due - tick
  return a >= 1 ? 1 : a > 0 ? a : 0
}
