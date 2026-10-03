import type { OpDef, OpImpl, PathPoint, ShapeDef, Vec2 } from '@elovox/terrain'

export type HandleKind = 'center' | 'radius' | 'falloff' | 'vertex' | 'insert' | 'width'

export interface Handle {
  kind: HandleKind
  /** vertex: the point's index; insert: the index the new point gets; 0 otherwise. */
  index: number
  x: number
  z: number
  /** The absolute height this handle carries (Shift+drag moves it), if any. */
  y?: number
}

export interface Outline { points: Vec2[]; closed: boolean; faint: boolean }

/** A point on a drag plane: x and z, plus y on a vertical (height) drag. */
export interface DragPoint { x: number; z: number; y?: number }

/** Blocks between the samples of a circle outline. */
const RING_STEP = 2

/** The param a circle's centre handle moves in y: an anchored number param named y (blob, flatten). */
export function heightKey(impl: OpImpl): string | null {
  const s = impl.params.y
  return s !== undefined && s.type === 'number' && s.anchor === 'ground' ? 'y' : null
}

/** The unit normal of a → b, to its left. `0 - …` avoids -0, which toEqual tells apart from 0. */
function normal(a: { x: number; z: number }, b: { x: number; z: number }): Vec2 {
  const dx = b.x - a.x, dz = b.z - a.z
  const l = Math.hypot(dx, dz) || 1
  return [0 - dz / l, 0 + dx / l]
}

function ring(c: Vec2, r: number): Vec2[] {
  const n = Math.max(24, Math.ceil((2 * Math.PI * r) / RING_STEP))
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2
    return [c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)] as Vec2
  })
}

export function handlesOf(def: OpDef, impl: OpImpl): Handle[] {
  const s = def.shape
  switch (s.kind) {
    case 'circle': {
      const [cx, cz] = s.center
      const key = heightKey(impl)
      const y = key === null ? undefined : def.params[key]
      const out: Handle[] = [
        { kind: 'center', index: 0, x: cx, z: cz, ...(typeof y === 'number' ? { y } : {}) },
        { kind: 'radius', index: 0, x: cx + s.radius, z: cz },
      ]
      if (impl.falloff) {
        const r = s.radius + (s.falloff ?? 0)
        out.push({ kind: 'falloff', index: 0, x: cx + r * Math.SQRT1_2, z: cz + r * Math.SQRT1_2 })
      }
      return out
    }
    case 'polygon': {
      const n = s.points.length
      const out: Handle[] = s.points.map(([x, z], i) => ({ kind: 'vertex', index: i, x, z }))
      for (let i = 0; i < n; i++) {
        const a = s.points[i]!, b = s.points[(i + 1) % n]!
        out.push({ kind: 'insert', index: i + 1, x: (a[0] + b[0]) / 2, z: (a[1] + b[1]) / 2 })
      }
      return out
    }
    case 'path': {
      const pts = s.points
      const out: Handle[] = pts.map((p, i) => ({ kind: 'vertex', index: i, x: p.x, z: p.z, ...(impl.needY && p.y !== undefined ? { y: p.y } : {}) }))
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!, b = pts[i]!
        out.push({ kind: 'insert', index: i, x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 })
      }
      const [nx, nz] = normal(pts[0]!, pts[1]!)
      out.push({ kind: 'width', index: 0, x: pts[0]!.x + (nx * s.width) / 2, z: pts[0]!.z + (nz * s.width) / 2 })
      return out
    }
  }
}

/** Outlines in x/z: a circle's ring (and falloff ring), a polygon, or a path's centre line and side lines. */
export function outlinesOf(def: OpDef): Outline[] {
  const s = def.shape
  switch (s.kind) {
    case 'circle': {
      const out: Outline[] = [{ points: ring(s.center, s.radius), closed: true, faint: false }]
      const f = s.falloff ?? 0
      if (f > 0) out.push({ points: ring(s.center, s.radius + f), closed: true, faint: true })
      return out
    }
    case 'polygon':
      return [{ points: s.points.map(([x, z]) => [x, z] as Vec2), closed: true, faint: false }]
    case 'path': {
      const out: Outline[] = [{ points: s.points.map((p) => [p.x, p.z] as Vec2), closed: false, faint: false }]
      for (let i = 1; i < s.points.length; i++) {
        const a = s.points[i - 1]!, b = s.points[i]!
        const [nx, nz] = normal(a, b)
        const ha = (a.width ?? s.width) / 2, hb = (b.width ?? s.width) / 2
        for (const side of [1, -1]) {
          out.push({ points: [[a.x + nx * ha * side, a.z + nz * ha * side], [b.x + nx * hb * side, b.z + nz * hb * side]], closed: false, faint: true })
        }
      }
      return out
    }
  }
}

/** Points along a polyline no more than `step` apart (to drape it on the terrain). A closed loop does not repeat its first point. */
export function resample(points: readonly Vec2[], closed: boolean, step: number): Vec2[] {
  const out: Vec2[] = []
  const n = points.length
  const segments = closed ? n : n - 1
  for (let i = 0; i < segments; i++) {
    const a = points[i]!, b = points[(i + 1) % n]!
    const k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step))
    for (let j = 0; j < k; j++) out.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k])
  }
  if (!closed && n > 0) out.push([points[n - 1]![0], points[n - 1]![1]])
  return out
}

export function translateShape(s: ShapeDef, dx: number, dz: number): ShapeDef {
  switch (s.kind) {
    case 'circle': return { ...s, center: [s.center[0] + dx, s.center[1] + dz] }
    case 'polygon': return { ...s, points: s.points.map(([x, z]) => [x + dx, z + dz] as Vec2) }
    case 'path': return { ...s, points: s.points.map((p) => ({ ...p, x: p.x + dx, z: p.z + dz })) }
  }
}

/** The op after dragging handle `h` (or the whole op, 'body') from `grab` to `to`. Values snap to whole blocks. */
export function dragHandle(def: OpDef, impl: OpImpl, h: Handle | 'body', grab: DragPoint, to: DragPoint): OpDef {
  const s = def.shape
  const r = Math.round
  if (h === 'body') return { ...def, shape: translateShape(s, r(to.x - grab.x), r(to.z - grab.z)) }
  switch (h.kind) {
    case 'center': {
      if (s.kind !== 'circle') return def
      if (to.y !== undefined) {
        const key = heightKey(impl)
        return key === null ? def : { ...def, params: { ...def.params, [key]: r(to.y) } }
      }
      return { ...def, shape: { ...s, center: [r(to.x), r(to.z)] } }
    }
    case 'radius': {
      if (s.kind !== 'circle') return def
      return { ...def, shape: { ...s, radius: Math.max(1, r(Math.hypot(to.x - s.center[0], to.z - s.center[1]))) } }
    }
    case 'falloff': {
      if (s.kind !== 'circle') return def
      return { ...def, shape: { ...s, falloff: Math.max(0, r(Math.hypot(to.x - s.center[0], to.z - s.center[1]) - s.radius)) } }
    }
    case 'vertex': {
      if (s.kind === 'polygon') {
        const points = s.points.slice()
        points[h.index] = [r(to.x), r(to.z)]
        return { ...def, shape: { ...s, points } }
      }
      if (s.kind === 'path') {
        const points = s.points.slice()
        const p = points[h.index]!
        points[h.index] = to.y !== undefined ? { ...p, y: r(to.y) } : { ...p, x: r(to.x), z: r(to.z) }
        return { ...def, shape: { ...s, points } }
      }
      return def
    }
    case 'insert': {
      if (s.kind === 'polygon') {
        const points = s.points.slice()
        points.splice(h.index, 0, [r(to.x), r(to.z)])
        return { ...def, shape: { ...s, points } }
      }
      if (s.kind === 'path') {
        const points = s.points.slice()
        const a = points[h.index - 1]!, b = points[h.index]!
        const p: PathPoint = { x: r(to.x), z: r(to.z) }
        if (a.y !== undefined && b.y !== undefined) p.y = r((a.y + b.y) / 2)
        points.splice(h.index, 0, p)
        return { ...def, shape: { ...s, points } }
      }
      return def
    }
    case 'width': {
      if (s.kind !== 'path') return def
      const p0 = s.points[0]!
      return { ...def, shape: { ...s, width: Math.max(1, r(2 * Math.hypot(to.x - p0.x, to.z - p0.z))) } }
    }
  }
}
