import type { CollapseTick, FragmentBirth, FragmentLanding } from '../sim/collapse.ts'
import { MARGIN, RUSH_MS } from './fallingTrack.ts'
import { SimClock } from './simClock.ts'

export interface FragmentFrame { birth: FragmentBirth; offset: number }
interface Tracked {
  birth: FragmentBirth; samples: { tick: number; offset: number }[]; sourcePending: boolean
  landing: FragmentLanding | null; rush: { from: number; at: number } | null
}

/** Membership lives here once; animation interpolates a single transform per connected fragment. */
export class FragmentTrack {
  private readonly bodies = new Map<number, Tracked>()
  private readonly clock: SimClock
  private newest = -Infinity
  constructor(clock: SimClock) { this.clock = clock }
  get size(): number { return this.bodies.size }
  holdsChunk(ci: number): boolean {
    for (const b of this.bodies.values()) if (b.sourcePending && b.birth.source.some(v => v.chunk === ci)) return true
    return false
  }
  sourcesReady(applied: (ci: number) => number): boolean {
    for (const b of this.bodies.values()) if (b.sourcePending && b.birth.source.some(v => applied(v.chunk) < v.version)) return false
    return true
  }
  releaseSources(): void { for (const b of this.bodies.values()) b.sourcePending = false; this.hold() }
  update(tick: number, data: CollapseTick | undefined, now: number): void {
    if (!data) return
    this.newest = tick
    this.clock.arrive(tick, now)
    for (const birth of data.born) this.bodies.set(birth.id, { birth, samples: [{ tick: tick - 1, offset: 0 }], sourcePending: true, landing: null, rush: null })
    for (let i = 0; i < data.poses.length; i += 3) {
      const b = this.bodies.get(data.poses[i]!)
      if (b) b.samples.push({ tick, offset: data.poses[i + 1]! })
    }
    for (const landing of data.landed) {
      const b = this.bodies.get(landing.id)
      if (b) { b.samples.push({ tick, offset: landing.offset256 }); b.landing = landing }
    }
    this.hold()
  }
  frame(now: number, applied: (ci: number) => number): FragmentFrame[] {
    const at = this.clock.advance(now) - 1 - MARGIN, out: FragmentFrame[] = []
    for (const [id, b] of this.bodies) {
      if (b.sourcePending) continue
      while (b.samples.length > 2 && b.samples[1]!.tick <= at) b.samples.shift()
      let offset = b.samples[0]!.offset
      for (let i = 1; i < b.samples.length; i++) {
        const a = b.samples[i - 1]!, c = b.samples[i]!
        if (at >= c.tick) offset = c.offset
        else if (at >= a.tick) { offset = a.offset + (c.offset - a.offset) * (at - a.tick) / (c.tick - a.tick); break }
      }
      if (b.landing && b.landing.chunks.every(v => applied(v.chunk) >= v.version)) {
        const target = b.landing.offset256
        if (offset !== target && !b.rush) b.rush = { from: offset, at: now }
        if (b.rush) {
          const duration = Math.max(RUSH_MS, Math.abs(target - b.rush.from) / (2.5 * 512 / this.clock.tickMs))
          offset = Math.min(offset, b.rush.from + (target - b.rush.from) * Math.min(1, (now - b.rush.at) / duration))
        }
        if (offset === target) { this.bodies.delete(id); continue }
      }
      out.push({ birth: b.birth, offset: offset / 256 })
    }
    this.hold(); return out
  }
  private hold(): void {
    let limit = this.newest + 1 + MARGIN
    for (const b of this.bodies.values()) if (b.sourcePending) limit = Math.min(limit, b.samples[0]!.tick + 1 + MARGIN)
    this.clock.hold(this, this.bodies.size ? limit : null)
  }
}
