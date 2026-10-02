import { describe, expect, it } from 'vitest'
import { HALF_STEP, fitShadow, frustumCorners, shadowDistance, type V3 } from '../src/render/shadowFit.ts'

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const norm = (a: V3): V3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l] }
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

const SUN = norm([0.45, 0.8, 0.35])
function viewCorners(shift = 0): V3[] {
  return frustumCorners([100 + shift, 80, 100], norm([-0.5, -0.6, -0.6]), [0, 1, 0], 50, 16 / 9, 0.1, 210)
}

describe('frustumCorners', () => {
  it('returns 4 near then 4 far corners at the right depths', () => {
    const pos: V3 = [0, 0, 0], fwd: V3 = [0, 0, -1]
    const c = frustumCorners(pos, fwd, [0, 1, 0], 90, 1, 1, 10)
    expect(c).toHaveLength(8)
    for (let i = 0; i < 4; i++) expect(dot(sub(c[i]!, pos), fwd)).toBeCloseTo(1)
    for (let i = 4; i < 8; i++) expect(dot(sub(c[i]!, pos), fwd)).toBeCloseTo(10)
    expect(Math.abs(c[4]![1])).toBeCloseTo(10) // tan(45°) × 10
  })
})

describe('fitShadow', () => {
  const basis = () => {
    const f = norm([-SUN[0], -SUN[1], -SUN[2]])
    const r = norm(cross(f, [0, 1, 0]))
    return { f, r, u: cross(r, f) }
  }

  it('contains every view corner in the ortho box', () => {
    const corners = viewCorners()
    const s = fitShadow(corners, SUN, 2048, 0, 128)
    const { f, r, u } = basis()
    const cr = dot(s.position, r), cu = dot(s.position, u), cf = dot(s.position, f)
    for (const c0 of corners) {
      const c: V3 = [c0[0], Math.min(128, Math.max(0, c0[1])), c0[2]]
      expect(Math.abs(dot(c, r) - cr)).toBeLessThanOrEqual(s.halfSize)
      expect(Math.abs(dot(c, u) - cu)).toBeLessThanOrEqual(s.halfSize)
      expect(dot(c, f) - cf).toBeGreaterThanOrEqual(s.near)
      expect(dot(c, f) - cf).toBeLessThanOrEqual(s.far)
    }
  })

  it('includes casters up the sun ray to the world top for a low sun', () => {
    const elev = (9 * Math.PI) / 180, yaw = (30 * Math.PI) / 180
    const sun: V3 = [Math.cos(elev) * Math.cos(yaw), Math.sin(elev), Math.cos(elev) * Math.sin(yaw)]
    const corners = viewCorners()
    const s = fitShadow(corners, sun, 2048, 0, 128)
    const f = norm([-sun[0], -sun[1], -sun[2]])
    const cf = dot(s.position, f)
    for (const c0 of corners) {
      const c: V3 = [c0[0], Math.min(128, Math.max(0, c0[1])), c0[2]]
      const k = (128 - c[1]) / sun[1]
      const q: V3 = [c[0] + sun[0] * k, c[1] + sun[1] * k, c[2] + sun[2] * k]
      expect(dot(q, f) - cf).toBeGreaterThanOrEqual(s.near)
      expect(dot(q, f) - cf).toBeLessThanOrEqual(s.far)
    }
  })

  it('snaps the centre to whole texels and quantises the size', () => {
    const s = fitShadow(viewCorners(), SUN, 2048, 0, 128)
    const { r, u } = basis()
    expect(s.halfSize % HALF_STEP).toBe(0)
    expect(s.texel).toBeCloseTo((2 * s.halfSize) / 2048)
    for (const axis of [r, u]) {
      const k = dot(s.position, axis) / s.texel
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6)
    }
  })

  it('moves only in whole texels when the camera moves a fraction of one', () => {
    const a = fitShadow(viewCorners(0), SUN, 2048, 0, 128)
    const b = fitShadow(viewCorners(a.texel * 0.3), SUN, 2048, 0, 128)
    const { r, u } = basis()
    expect(b.halfSize).toBe(a.halfSize)
    for (const axis of [r, u]) {
      const k = (dot(b.position, axis) - dot(a.position, axis)) / a.texel
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6)
    }
  })

  it('handles a sun straight overhead without NaN', () => {
    const s = fitShadow(viewCorners(), [0, 1, 0], 2048, 0, 128)
    for (const v of [...s.position, ...s.target, ...s.up, s.halfSize, s.near, s.far]) expect(Number.isFinite(v)).toBe(true)
  })
})

describe('shadowDistance', () => {
  it('scales with the orbit distance inside [96, 350]', () => {
    expect(shadowDistance(10)).toBe(96)
    expect(shadowDistance(70)).toBe(210)
    expect(shadowDistance(400)).toBe(350)
  })
})
