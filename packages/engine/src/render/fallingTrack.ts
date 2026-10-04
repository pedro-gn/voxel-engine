import type { FallingBodyState, Landing } from '../sim/gravity.ts'

export interface FallingCube { voxel: number; x: number; y: number; z: number }

interface Tracked { voxel: number; x: number; z: number; prevY: number; curY: number; landing: { chunk: number; version: number } | null }

/**
 * Follows falling bodies between sim ticks for drawing (no three.js, so Node tests reach it). A body is drawn
 * between its last two heights; a landed body stays until its chunk's mesh at the landing version is applied,
 * so a block never blinks out between the cube and the chunk mesh.
 */
export class FallingTrack {
  private readonly bodies = new Map<number, Tracked>()
  private tickAt = 0

  get size(): number { return this.bodies.size }

  /** A tick message arrived at `now` (ms). */
  update(falling: readonly FallingBodyState[], landed: readonly Landing[], now: number): void {
    const seen = new Set<number>()
    for (const s of falling) {
      seen.add(s.id)
      const b = this.bodies.get(s.id)
      if (b) { b.prevY = b.curY; b.curY = s.y256 }
      else this.bodies.set(s.id, { voxel: s.voxel, x: s.x, z: s.z, prevY: s.y256 + s.vy256, curY: s.y256, landing: null })
    }
    for (const l of landed) {
      const b = this.bodies.get(l.id)
      if (!b) continue // started and landed within one tick: the chunk mesh covers it
      seen.add(l.id)
      b.prevY = b.curY
      b.curY = l.y * 256
      b.landing = { chunk: l.chunk, version: l.version }
    }
    for (const [id, b] of this.bodies) {
      if (seen.has(id)) continue
      if (b.landing) b.prevY = b.curY
      else this.bodies.delete(id)
    }
    this.tickAt = now
  }

  /** Cubes to draw at `now`, y in blocks. `applied(chunk)` is the chunk's applied mesh version. */
  frame(now: number, tickMs: number, applied: (chunk: number) => number): FallingCube[] {
    const a = Math.min(1, Math.max(0, (now - this.tickAt) / tickMs))
    const out: FallingCube[] = []
    for (const [id, b] of this.bodies) {
      if (b.landing && applied(b.landing.chunk) >= b.landing.version) { this.bodies.delete(id); continue }
      out.push({ voxel: b.voxel, x: b.x, y: (b.prevY + (b.curY - b.prevY) * a) / 256, z: b.z })
    }
    return out
  }
}
