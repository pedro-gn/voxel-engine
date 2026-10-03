import type { Box } from '../geom.ts'

/** A tube vertex: centre, horizontal half-width `hw`, vertical half-height `hh`. */
export interface TubePoint { x: number; y: number; z: number; hw: number; hh: number }

export interface Tube {
  readonly bounds: Box
  /** Blocks inside the elliptical cross-section: > 0 inside, 0 on the wall, < 0 outside. */
  field(x: number, y: number, z: number): number
}

/** A tube along a 3D polyline with an elliptical cross-section that can change along the way. */
export function compileTube(points: readonly TubePoint[], pad: number): Tube {
  const n = points.length
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y), zs = points.map((p) => p.z)
  const r = Math.max(...points.map((p) => p.hw)) + pad, rh = Math.max(...points.map((p) => p.hh)) + pad
  return {
    bounds: {
      x0: Math.min(...xs) - r, x1: Math.max(...xs) + r,
      y0: Math.min(...ys) - rh, y1: Math.max(...ys) + rh,
      z0: Math.min(...zs) - r, z1: Math.max(...zs) + r,
    },
    field(x, y, z) {
      let best = Infinity
      for (let i = 0; i < n - 1; i++) {
        const a = points[i]!, b = points[i + 1]!
        const ex = b.x - a.x, ey = b.y - a.y, ez = b.z - a.z
        const len2 = ex * ex + ey * ey + ez * ez
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * ex + (y - a.y) * ey + (z - a.z) * ez) / len2)) : 0
        const hw = a.hw + (b.hw - a.hw) * t, hh = a.hh + (b.hh - a.hh) * t
        const dx = x - (a.x + ex * t), dy = y - (a.y + ey * t), dz = z - (a.z + ez * t)
        const q = Math.sqrt((dx * dx + dz * dz) / (hw * hw) + (dy * dy) / (hh * hh))
        const s = (1 - q) * Math.min(hw, hh)
        if (-s < best) best = -s
      }
      return -best
    },
  }
}

/** Points of the quadratic Bézier from p0 to p2 whose middle is lifted by `rise`. */
export function archCurve(p0: TubePoint, p2: TubePoint, rise: number, segments: number): TubePoint[] {
  const c = { x: (p0.x + p2.x) / 2, y: (p0.y + p2.y) / 2 + rise * 2, z: (p0.z + p2.z) / 2 }
  const out: TubePoint[] = []
  for (let i = 0; i <= segments; i++) {
    const t = i / segments, u = 1 - t
    out.push({
      x: u * u * p0.x + 2 * u * t * c.x + t * t * p2.x,
      y: u * u * p0.y + 2 * u * t * c.y + t * t * p2.y,
      z: u * u * p0.z + 2 * u * t * c.z + t * t * p2.z,
      hw: p0.hw + (p2.hw - p0.hw) * t,
      hh: p0.hh + (p2.hh - p0.hh) * t,
    })
  }
  return out
}
