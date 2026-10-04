import type { FallingBodyState, Landing } from '../sim/gravity.ts'

export interface FallingCube { voxel: number; x: number; y: number; z: number }

const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const

/**
 * The packed light (sky | block << 4) a cube whose bottom is at height `y` (blocks) is drawn with: its cell's.
 * A dark cell is the landed block itself (an opaque cell holds no light) while the cube waits for the chunk mesh,
 * so then each channel comes from the brightest face neighbour, as the mesh will light the block's faces;
 * otherwise the whole landed pillar flashes black at the hand-over.
 */
export function cubeLight(light: (x: number, y: number, z: number) => number, x: number, y: number, z: number): number {
  const cy = Math.floor(y + 0.5)
  const own = light(x, cy, z)
  if (own !== 0) return own
  let sky = 0, blk = 0
  for (const [dx, dy, dz] of FACES) {
    const l = light(x + dx, cy + dy, z + dz)
    sky = Math.max(sky, l & 15)
    blk = Math.max(blk, l >> 4)
  }
  return sky | (blk << 4)
}

/** Extra drawing lag, in ticks, beyond the one tick between a body's last two heights: room for arrival jitter. */
export const MARGIN = 0.2
/** How much faster or slower than real time the drawn clock may run while it follows the latency estimate. */
const SLEW = 0.1
/** The same when the drawn clock lags the estimate by more than a tick (after a hitch): catch up faster. */
const FAST_SLEW = 0.5
/** The latency estimate is the slowest arrival of this window (ms), so a single hitch is forgotten after it. */
const WINDOW = 500
/** A latency change beyond this many ticks restarts the estimate from the new arrival. */
const RESYNC = 4
/** Once its chunk mesh is in, a landed cube still gliding reaches its cell within this many ms... */
export const RUSH_MS = 30
/** ...but never faster than this many times terminal speed (2 blocks per tick). */
export const RUSH_CAP = 2.5

interface Sample { tick: number; y: number }

interface Tracked {
  voxel: number; x: number; z: number
  /** Heights (y256) by sim tick, oldest first. */
  samples: Sample[]
  landing: { chunk: number; version: number } | null
  /** Set when a landed body's mesh is in before it reached its cell: it finishes its glide on its own clock. */
  rush: { y: number; at: number; speed: number } | null
}

/**
 * Follows falling bodies between sim ticks for drawing (no three.js, so Node tests reach it).
 *
 * Bodies are drawn on a smoothed sim clock, not on message arrival: tick `t` is drawn at render time
 * `(t + 1 + MARGIN) × tickMs + offset`, where `offset` follows the slowest arrival latency (arrival − t × tickMs)
 * of the last WINDOW ms, slewed at most SLEW (FAST_SLEW when far behind) so the drawn speed never jumps. A late
 * message holds the cubes at the newest height (nothing is extrapolated) and delays the clock by the wait; an
 * early one is simply buffered.
 *
 * A landed body glides on to its landing cell, then stays there until its chunk's mesh at the landing version is
 * applied, so a block never blinks out or jumps between the cube and the chunk mesh. If the mesh comes first (the
 * usual case, since cubes are drawn a tick behind), the rest of the glide is compressed to about RUSH_MS so the
 * block is not shown twice for long.
 */
export class FallingTrack {
  private readonly bodies = new Map<number, Tracked>()
  private readonly tickMs: number
  /** Arrivals of the last WINDOW ms: (time, arrival − tick × tickMs). */
  private readonly arrivals: { at: number; s: number }[] = []
  /** Their maximum: the latency the drawn clock aims for. */
  private latency = Number.NaN
  /** The drawn clock's latency term; follows `latency` at a limited rate. */
  private offset = Number.NaN
  private frameAt = 0
  /** The newest sim tick received. */
  private newest = Number.NEGATIVE_INFINITY

  /** `tickMs`: the sim's nominal tick length. */
  constructor(tickMs: number) { this.tickMs = tickMs }

  get size(): number { return this.bodies.size }

  /** The message of sim tick `tick` arrived at `now` (ms). */
  update(tick: number, falling: readonly FallingBodyState[], landed: readonly Landing[], now: number): void {
    const s = now - tick * this.tickMs
    if (Number.isNaN(this.latency) || Math.abs(s - this.latency) > RESYNC * this.tickMs) {
      // A first arrival, or the sim paused or the page stalled: start the estimate over. With cubes on screen the
      // drawn clock keeps its offset (a hold or the slew absorbs the change) so they never move back up.
      this.arrivals.length = 0
      if (this.bodies.size === 0 || Number.isNaN(this.offset)) this.offset = s
    }
    this.arrivals.push({ at: now, s })
    while (this.arrivals[0]!.at < now - WINDOW) this.arrivals.shift()
    this.latency = Math.max(...this.arrivals.map((a) => a.s))
    this.newest = Math.max(this.newest, tick)
    const seen = new Set<number>()
    for (const st of falling) {
      seen.add(st.id)
      const b = this.bodies.get(st.id)
      if (b) push(b, tick, st.y256)
      else this.bodies.set(st.id, { voxel: st.voxel, x: st.x, z: st.z, samples: [{ tick: tick - 1, y: st.y256 + st.vy256 }, { tick, y: st.y256 }], landing: null, rush: null })
    }
    for (const l of landed) {
      const b = this.bodies.get(l.id)
      if (!b) continue // started and landed within one tick: the chunk mesh covers it
      seen.add(l.id)
      push(b, tick, l.y * 256)
      b.landing = { chunk: l.chunk, version: l.version }
    }
    for (const [id, b] of this.bodies) if (!seen.has(id) && !b.landing) this.bodies.delete(id)
  }

  /** Cubes to draw at `now`, y in blocks. `applied(chunk)` is the chunk's applied mesh version. */
  frame(now: number, applied: (chunk: number) => number): FallingCube[] {
    const target = this.latency
    if (this.bodies.size === 0 || Number.isNaN(this.offset)) this.offset = target
    else {
      const rate = this.offset - target > this.tickMs ? FAST_SLEW : SLEW
      const step = rate * Math.max(0, now - this.frameAt)
      this.offset += Math.min(step, Math.max(-step, target - this.offset))
    }
    this.frameAt = now
    let at = (now - this.offset) / this.tickMs - 1 - MARGIN // the sim tick drawn now, fractional
    if (this.bodies.size > 0 && at > this.newest) {
      // The next message is late: hold at the newest tick and push the clock back by the wait, so the cubes
      // go on from here when it comes instead of catching up in a jump.
      at = this.newest
      this.offset = now - (at + 1 + MARGIN) * this.tickMs
    }
    const out: FallingCube[] = []
    for (const [id, b] of this.bodies) {
      while (b.samples.length > 2 && b.samples[1]!.tick <= at) b.samples.shift() // heights already drawn past
      let y = heightAt(b.samples, at)
      if (b.landing) {
        const land = b.samples[b.samples.length - 1]!.y
        const meshIn = applied(b.landing.chunk) >= b.landing.version
        if (meshIn && y !== land && !b.rush) {
          const cap = (RUSH_CAP * 512) / this.tickMs
          b.rush = { y, at: now, speed: Math.min(cap, Math.max((y - land) / RUSH_MS, 0)) }
        }
        if (b.rush) y = Math.min(y, Math.max(land, b.rush.y - b.rush.speed * (now - b.rush.at)))
        // A landed cube is handed over only once it rests in its landing cell and that cell's mesh is in.
        if (meshIn && y === land) { this.bodies.delete(id); continue }
      }
      out.push({ voxel: b.voxel, x: b.x, y: y / 256, z: b.z })
    }
    return out
  }
}
function push(b: Tracked, tick: number, y: number): void {
  b.samples.push({ tick, y })
}

/** The height at fractional sim tick `at`, held at the oldest and newest samples. */
function heightAt(samples: readonly Sample[], at: number): number {
  const first = samples[0]!, last = samples[samples.length - 1]!
  if (at <= first.tick) return first.y
  if (at >= last.tick) return last.y
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!, b = samples[i]!
    if (at <= b.tick) return a.y + ((b.y - a.y) * (at - a.tick)) / (b.tick - a.tick)
  }
  return last.y
}
