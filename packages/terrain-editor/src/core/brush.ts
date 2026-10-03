import { smoothstep01 } from '@elovox/terrain'

/** Radius in blocks; strength and falloff in [0, 1]. Falloff is the fraction of the radius over which the weight fades to zero. */
export interface BrushSettings { radius: number; strength: number; falloff: number }
export interface Point3 { x: number; y: number; z: number }

export const RADIUS_MIN = 2
export const RADIUS_MAX = 64

/** The settings with every field clamped into its range. */
export function clampSettings(s: BrushSettings): BrushSettings {
  const c = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  return { radius: c(s.radius, RADIUS_MIN, RADIUS_MAX), strength: c(s.strength, 0, 1), falloff: c(s.falloff, 0, 1) }
}

/** The weight at distance `d` from the centre: the strength inside the core, a smoothstep down to 0 at the radius, 0 past it. */
export function brushWeight(d: number, s: BrushSettings): number {
  if (d > s.radius) return 0
  const core = s.radius * (1 - s.falloff)
  if (d <= core) return s.strength
  return s.strength * smoothstep01((s.radius - d) / (s.radius - core))
}

/** Blocks between dabs for a brush radius. */
export function dabSpacing(radius: number): number { return Math.max(1, radius * 0.25) }

/** Places dabs every `spacing` blocks along a stroke, whatever the pointer events in between. */
export class DabSpacer {
  private readonly spacing: number
  private last: Point3 | null = null
  /** Distance walked since the last dab. */
  private walked = 0

  constructor(spacing: number) { this.spacing = spacing }

  /** The dabs from the previous point to `p`. The first call dabs at `p`. */
  to(p: Point3): Point3[] {
    const a = this.last
    this.last = p
    if (!a) return [p]
    const dx = p.x - a.x, dy = p.y - a.y, dz = p.z - a.z
    const len = Math.hypot(dx, dy, dz)
    const out: Point3[] = []
    let t = this.spacing - this.walked
    while (t <= len) {
      const f = t / len
      out.push({ x: a.x + dx * f, y: a.y + dy * f, z: a.z + dz * f })
      t += this.spacing
    }
    this.walked = len - (t - this.spacing)
    return out
  }
}
