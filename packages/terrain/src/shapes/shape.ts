import type { Check } from '../doc/check.ts'
import type { ShapeDef, ShapeKind } from '../doc/types.ts'
import type { Rect } from '../geom.ts'
import { smoothstep01 } from './profile.ts'

/** What an op learns about a point from its shape. Reused across calls: `sample` overwrites it. */
export interface ShapeSample {
  /** Distance outside the shape's edge in blocks; <= 0 inside. */
  dist: number
  /** 0 at the centre (circle) or axis (path), 1 at the edge, > 1 outside. Polygons: 0 at `inset` inside the edge. */
  edge: number
  /** Paths: position along the path, 0 at the first point, 1 at the last. 0 for other shapes. */
  along: number
  /** Paths: y interpolated at the closest point (0 where points have no y). 0 for other shapes. */
  y: number
  /** Paths: width at the closest point. Circles: the diameter. Polygons: 0. */
  width: number
}

export interface Shape {
  readonly kind: ShapeKind
  /** The shape itself, without falloff. */
  readonly bounds: Rect
  readonly falloff: number
  sample(x: number, z: number, out: ShapeSample): void
}

export function newSample(): ShapeSample { return { dist: 0, edge: 0, along: 0, y: 0, width: 0 } }

/** 1 inside the shape, fading smoothly to 0 at `falloff` blocks outside its edge. */
export function weight(s: ShapeSample, falloff: number): number {
  if (s.dist <= 0) return 1
  if (s.dist >= falloff) return 0
  return smoothstep01(1 - s.dist / falloff)
}

export function compileShape(def: ShapeDef): Shape {
  switch (def.kind) {
    case 'circle': return circle(def.center[0], def.center[1], def.radius, def.falloff ?? 0)
    case 'polygon': return polygon(def.points, def.inset ?? 16, def.falloff ?? 0)
    case 'path': return path(def.points, def.width, def.falloff ?? 0)
  }
}

function circle(cx: number, cz: number, radius: number, falloff: number): Shape {
  return {
    kind: 'circle',
    bounds: { x0: cx - radius, z0: cz - radius, x1: cx + radius, z1: cz + radius },
    falloff,
    sample(x, z, out) {
      const r = Math.hypot(x - cx, z - cz)
      out.dist = r - radius
      out.edge = r / radius
      out.along = 0
      out.y = 0
      out.width = radius * 2
    },
  }
}

function polygon(points: readonly [number, number][], inset: number, falloff: number): Shape {
  const n = points.length
  const xs = Float64Array.from(points, (p) => p[0]), zs = Float64Array.from(points, (p) => p[1])
  return {
    kind: 'polygon',
    bounds: { x0: Math.min(...xs), z0: Math.min(...zs), x1: Math.max(...xs), z1: Math.max(...zs) },
    falloff,
    sample(x, z, out) {
      let best = Infinity, inside = false
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ax = xs[j]!, az = zs[j]!, bx = xs[i]!, bz = zs[i]!
        if ((bz > z) !== (az > z) && x < ((ax - bx) * (z - bz)) / (az - bz) + bx) inside = !inside
        const ex = bx - ax, ez = bz - az
        const len2 = ex * ex + ez * ez
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2)) : 0
        const d = Math.hypot(x - (ax + ex * t), z - (az + ez * t))
        if (d < best) best = d
      }
      out.dist = inside ? -best : best
      out.edge = inside ? Math.max(0, 1 - best / inset) : 1 + best / inset
      out.along = 0
      out.y = 0
      out.width = 0
    },
  }
}

function path(points: readonly { x: number; z: number; y?: number; width?: number }[], width: number, falloff: number): Shape {
  const n = points.length
  const xs = Float64Array.from(points, (p) => p.x), zs = Float64Array.from(points, (p) => p.z)
  const ys = Float64Array.from(points, (p) => p.y ?? 0), ws = Float64Array.from(points, (p) => p.width ?? width)
  const cum = new Float64Array(n) // cumulative length at each vertex
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1]! + Math.hypot(xs[i]! - xs[i - 1]!, zs[i]! - zs[i - 1]!)
  const total = cum[n - 1]! || 1
  const half = Math.max(...ws) / 2
  return {
    kind: 'path',
    bounds: { x0: Math.min(...xs) - half, z0: Math.min(...zs) - half, x1: Math.max(...xs) + half, z1: Math.max(...zs) + half },
    falloff,
    sample(x, z, out) {
      let best = Infinity, bi = 0, bt = 0
      for (let i = 0; i < n - 1; i++) {
        const ax = xs[i]!, az = zs[i]!, ex = xs[i + 1]! - ax, ez = zs[i + 1]! - az
        const len2 = ex * ex + ez * ez
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len2)) : 0
        const d = Math.hypot(x - (ax + ex * t), z - (az + ez * t))
        if (d < best) { best = d; bi = i; bt = t }
      }
      const w = ws[bi]! + (ws[bi + 1]! - ws[bi]!) * bt
      const hw = w / 2
      out.dist = best - hw
      out.edge = best / hw
      out.along = (cum[bi]! + (cum[bi + 1]! - cum[bi]!) * bt) / total
      out.y = ys[bi]! + (ys[bi + 1]! - ys[bi]!) * bt
      out.width = w
    },
  }
}

const KINDS: readonly ShapeKind[] = ['circle', 'polygon', 'path']

/** Validates a ShapeDef. `kinds` restricts the kinds an op accepts; `needY` requires y on every path point. */
export function checkShape(c: Check, path: string, v: unknown, kinds: readonly ShapeKind[] = KINDS, needY = false): v is ShapeDef {
  if (!c.obj(path, v)) return false
  if (!c.str(`${path}.kind`, v.kind, kinds)) return false
  const before = c.errors.length
  c.num(`${path}.falloff`, v.falloff, { min: 0, optional: true })
  if (v.kind === 'circle') {
    c.vec2(`${path}.center`, v.center)
    c.num(`${path}.radius`, v.radius, { gt: 0 })
  } else if (v.kind === 'polygon') {
    c.num(`${path}.inset`, v.inset, { gt: 0, optional: true })
    if (c.arr(`${path}.points`, v.points, 3)) v.points.forEach((p, i) => c.vec2(`${path}.points[${i}]`, p))
  } else {
    c.num(`${path}.width`, v.width, { gt: 0 })
    if (c.arr(`${path}.points`, v.points, 2)) {
      v.points.forEach((p, i) => {
        const pp = `${path}.points[${i}]`
        if (!c.obj(pp, p)) return
        c.num(`${pp}.x`, p.x)
        c.num(`${pp}.z`, p.z)
        c.num(`${pp}.y`, p.y, { optional: !needY })
        c.num(`${pp}.width`, p.width, { gt: 0, optional: true })
      })
    }
  }
  return c.errors.length === before
}
