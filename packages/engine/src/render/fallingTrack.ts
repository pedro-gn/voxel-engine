import type { FallingBodyState, Landing } from '../sim/gravity.ts'
import { RESYNC, SimClock } from './simClock.ts'

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
/**
 * Heights kept per body while no frame has run for WINDOW ms (a background tab). The first frame back slews the
 * clock straight to the estimate, at most 1 + MARGIN + RESYNC ticks behind the newest, so older ones are never drawn.
 */
const IDLE_KEEP = RESYNC + 3
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
 * Bodies are drawn on the smoothed sim clock (SimClock), not on message arrival: tick `t` is drawn 1 + MARGIN ticks after
 * it is due, so at render time `(t + 1 + MARGIN) × tickMs + offset`. While bodies are drawn the track holds the clock at
 * the newest height: a late message holds the cubes there (nothing is extrapolated) and delays the clock by the wait; an
 * early one is simply buffered. The clock may be shared with other things drawn on it (the water surface).
 *
 * A landed body glides on to its landing cell, then stays there until its chunk's mesh at the landing version is
 * applied, so a block never blinks out or jumps between the cube and the chunk mesh. If the mesh comes first (the
 * usual case, since cubes are drawn a tick behind), the rest of the glide is compressed to about RUSH_MS so the
 * block is not shown twice for long.
 */
export class FallingTrack {
  private readonly bodies = new Map<number, Tracked>()
  private readonly tickMs: number
  private readonly clock: SimClock

  /** `tickMs`: the sim's nominal tick length. `clock`: the sim clock to draw on (fed by update, advanced by frame). */
  constructor(tickMs: number, clock = new SimClock(tickMs)) {
    this.tickMs = tickMs
    this.clock = clock
  }

  get size(): number { return this.bodies.size }

  /** The message of sim tick `tick` arrived at `now` (ms). */
  update(tick: number, falling: readonly FallingBodyState[], landed: readonly Landing[], now: number): void {
    // Cubes on screen hold the clock (see hold), so a restarted estimate never moves them back up.
    this.clock.arrive(tick, now)
    const idle = this.clock.idle(now)
    const seen = new Set<number>()
    for (const st of falling) {
      seen.add(st.id)
      const b = this.bodies.get(st.id)
      if (b) push(b, tick, st.y256, idle)
      else this.bodies.set(st.id, { voxel: st.voxel, x: st.x, z: st.z, samples: [{ tick: tick - 1, y: st.y256 + st.vy256 }, { tick, y: st.y256 }], landing: null, rush: null })
    }
    for (const l of landed) {
      const b = this.bodies.get(l.id)
      if (!b) continue // started and landed within one tick: the chunk mesh covers it
      seen.add(l.id)
      push(b, tick, l.y * 256, idle)
      b.landing = { chunk: l.chunk, version: l.version }
    }
    for (const [id, b] of this.bodies) if (!seen.has(id) && !b.landing) this.bodies.delete(id)
    this.hold()
  }

  /** Cubes to draw at `now`, y in blocks. `applied(chunk)` is the chunk's applied mesh version. */
  frame(now: number, applied: (chunk: number) => number): FallingCube[] {
    let at = this.clock.advance(now) - 1 - MARGIN // the sim tick drawn now, fractional
    // The clock holds at the newest tick (see hold); this only drops the rounding of its `+ 1 + MARGIN − 1 − MARGIN`.
    if (this.bodies.size > 0 && at > this.clock.newest) at = this.clock.newest
    const out: FallingCube[] = []
    for (const [id, b] of this.bodies) {
      // Drop the heights already drawn past, keeping the one at or before `at` and at least two.
      let cut = 0
      while (cut < b.samples.length - 2 && b.samples[cut + 1]!.tick <= at) cut++
      if (cut > 0) b.samples.splice(0, cut)
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
    this.hold()
    return out
  }

  /** While cubes are drawn, the clock may show their newest height at most; nothing is extrapolated. */
  private hold(): void {
    this.clock.hold(this, this.bodies.size > 0 ? this.clock.newest + 1 + MARGIN : null)
  }
}
function push(b: Tracked, tick: number, y: number, idle: boolean): void {
  b.samples.push({ tick, y })
  if (idle && b.samples.length > IDLE_KEEP) b.samples.splice(0, b.samples.length - IDLE_KEEP)
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
