import type * as THREE from 'three/webgpu'
import { attribute, bool, float, instanceIndex, mix, normalize, select, smoothstep, uniform, varying, vec2, vec3 } from 'three/tsl'
import { chunkVertex } from '../chunkVertex.ts'
import { ARC_GAP, ARC_SEGMENTS, SPLASH_LIFT, SPLASH_MAX, SPLASH_PER_ROOT } from './surfaceMesh.ts'

/** Loose TSL node type (see voxelLighting.ts). */
type N = any

/**
 * How far the heightfield is through its current water step (0–1), on the engine's smoothed sim clock (render/simClock.ts);
 * the engine sets it every frame.
 */
export const waterAlpha = uniform(1)

/** What the water shading reads, whatever draws the water: static voxel cells, the heightfield surface or a curtain. */
export interface WaterVertex {
  /** The local position (the material's positionNode). */
  position: THREE.Node<'vec3'>
  /** World-space normal. */
  normal: THREE.Node<'vec3'>
  /** True for a surface (ripples); false for a side or a curtain (falling streaks). */
  isTop: THREE.Node<'bool'>
  sky: THREE.Node<'float'>
  blk: THREE.Node<'float'>
  /** Ripple flow: direction x, z and speed (0 still, 1 gentle, 2.5 steep). */
  flow: THREE.Node<'vec3'>
  /** 0–1: how much shore foam the water may get (thin films get little). */
  surface: THREE.Node<'float'>
  /** 0–1: white water. */
  white: THREE.Node<'float'>
  /** Streak speed factor on sides and curtains. */
  fall: THREE.Node<'float'>
  /** Opacity factor. */
  alpha: THREE.Node<'float'>
}

/** Component k (0–3) of a vec4. */
function pick4(v: N, k: N): N {
  return select(k.lessThan(0.5), v.x, select(k.lessThan(1.5), v.y, select(k.lessThan(2.5), v.z, v.w)))
}

/**
 * Light packed as sky × 16 + block (+ 256 × white), decoded in the vertex stage. Decoding in the fragment stage would floor
 * an interpolated value and flip the nibbles (see falling.ts).
 */
function unpack(packed: N): { sky: N; blk: N; white: N } {
  const p = packed.max(0)
  const white = p.div(256).floor()
  const rest = p.sub(white.mul(256))
  return { sky: varying(rest.div(16).floor().div(15)), blk: varying(rest.mod(16).div(15)), white: varying(white.div(15)) }
}

/** Static voxel water: the chunk liquid layer's packed vertex. It never flows: what moves is the heightfield. */
export function voxelWaterVertex(): WaterVertex {
  const v = chunkVertex(undefined, true)
  return {
    position: v.position, normal: v.normal, isTop: v.normal.y.greaterThan(0.5), sky: v.sky, blk: v.blk,
    flow: vec3(0, 0, 0), surface: v.surface, white: float(0), fall: float(1), alpha: float(1),
  }
}

/**
 * The heightfield surface: one instanced quad per column of a chunk column (WaterSurface), instance lx + lz × 32. The base
 * quad's `corner` attribute (0–3: (−x,−z) (+x,−z) (+x,+z) (−x,+z)) picks the corner of `hPrev`/`hCur`, mixed by waterAlpha.
 * A negative info.w collapses the quad to a line (nothing drawn).
 */
export function surfaceVertex(): WaterVertex {
  const corner = attribute('corner', 'float')
  const hp = attribute('hPrev', 'vec4'), hc = attribute('hCur', 'vec4'), info = attribute('info', 'vec4')
  const h = mix(hp, hc, waterAlpha)
  const i = instanceIndex.toFloat()
  const lz = i.div(32).floor(), lx = i.sub(lz.mul(32))
  const shown = select(info.w.lessThan(0), float(0), float(1))
  const ox = select(corner.greaterThan(0.5).and(corner.lessThan(2.5)), float(1), float(0)).mul(shown)
  const oz = select(corner.greaterThan(1.5), float(1), float(0)).mul(shown)
  // The quad's plane from its four corners: rise along x and along z.
  const dx = h.y.add(h.z).sub(h.x).sub(h.w).mul(0.5)
  const dz = h.z.add(h.w).sub(h.x).sub(h.y).mul(0.5)
  const { sky, blk, white } = unpack(info.w)
  const speed = vec2(info.x, info.y).length()
  const dir = vec2(info.x, info.y).div(speed.max(0.001))
  return {
    position: vec3(lx.add(ox), pick4(h, corner), lz.add(oz)),
    normal: varying(normalize(vec3(dx.negate(), float(1), dz.negate()))),
    isTop: bool(true),
    sky, blk, white,
    flow: varying(vec3(dir.x, dir.y, speed)),
    surface: varying(smoothstep(0.05, 0.35, info.z)),
    fall: float(1),
    alpha: float(1),
  }
}

/**
 * A waterfall curtain (WaterSurface): one instanced body per curtain, a ballistic arc with thickness, sides and a splash.
 * - The base geometry's `strip` attribute is (s, end, face, kind): `end` 0 for the edge's end A and 1 for B (the edge's ends
 *   sit on the upper column's side `dir`: 0 +x, 1 −x, 2 +z, 3 −z); `kind` 0 for the front (face 0) and back (face 1) faces
 *   of the body, where s is the fall fraction (0 top, 1 foot, evenly in time); 1 for a side face, whose vertices lie on the
 *   front (face 0) and back (face 1) at s; 2 for the splash at the foot, whose s is the signed row (−1, 0, 1) across it.
 * - cPrev/cCur hold (top A, top B, foot A, foot B); cReach, cThick and cFlare hold per end (A, B in the previous step, then
 *   A, B in the current one) its reach, the thickness of its body and its flare. Each is mixed by waterAlpha.
 * - cInfo is (lx, lz, dir + 4 × (light + 256 × water), flux), water flagging (bit 0 A, bit 1 B) the ends that land on water.
 * Each end's front point lies arcPoint(top, foot, reach, s) (surfaceMesh.ts) away: in front of the wall's plane along `dir`
 * (by ARC_GAP at least below the top, so it never meets the wall it pours from), and down from the top; its back point
 * backPoint(…, thick, s) that much nearer the wall. A free end (flare ≥ 0) moves out along the edge by flare × s; an end
 * shared with the curtain beside it (FLARE_SHARED) does not, and its side face collapses (no seam where bodies join).
 * The splash is a white strip across the foot at the landing point, as wide as the flux gives it, fading out to its rows'
 * edges, where the landing column is water.
 */
export function curtainVertex(): WaterVertex {
  const strip = attribute('strip', 'vec4')
  const cp = attribute('cPrev', 'vec4'), cc = attribute('cCur', 'vec4'), info = attribute('cInfo', 'vec4')
  const reach = attribute('cReach', 'vec4'), thick = attribute('cThick', 'vec4'), flare = attribute('cFlare', 'vec4')
  const a = waterAlpha
  const h = mix(cp, cc, a)
  const dir = info.z.mod(4)
  const lightWater = info.z.div(4).floor()
  const water = lightWater.div(256).floor()
  const light = lightWater.sub(water.mul(256))
  const isB = strip.y.greaterThan(0.5)
  const face = strip.z, kind = strip.w
  const isSide = kind.greaterThan(0.5).and(kind.lessThan(1.5))
  const isSplash = kind.greaterThan(1.5)
  const one = float(1), zero = float(0)
  // The fall fraction (the splash lies at the foot) and the splash's row.
  const s = select(isSplash, one, strip.x)
  const row = strip.x
  const r = select(isB, mix(reach.y, reach.w, a), mix(reach.x, reach.z, a))
  const t = select(isB, mix(thick.y, thick.w, a), mix(thick.x, thick.z, a))
  const flareP = select(isB, flare.y, flare.x), flareC = select(isB, flare.w, flare.z)
  const flareAmount = mix(flareP.max(0), flareC.max(0), a)
  const open = mix(select(flareP.greaterThanEqual(0), one, zero), select(flareC.greaterThanEqual(0), one, zero), a)
  const d0 = dir.lessThan(0.5), d1 = dir.lessThan(1.5), d2 = dir.lessThan(2.5)
  const ax = select(d0, one, select(d1, zero, select(d2, one, zero)))
  const az = select(d0, zero, select(d1, one, select(d2, one, zero)))
  const bx = select(d0, one, select(d1, zero, select(d2, zero, one)))
  const bz = select(d0, one, select(d1, zero, select(d2, one, zero)))
  // Outward: the direction the water leaves its column in; along: from this end out past the edge (the flare's direction).
  const ox = select(d0, one, select(d1, float(-1), zero))
  const oz = select(d1, zero, select(d2, one, float(-1)))
  const lx = select(isB, bx.sub(ax), ax.sub(bx)), lz = select(isB, bz.sub(az), az.sub(bz))
  const top = select(isB, h.y, h.x), drop = top.sub(select(isB, h.w, h.z))
  const gap = s.mul(ARC_SEGMENTS).min(1).mul(ARC_GAP)
  const front = r.mul(s).add(gap)
  // The back face is `t` nearer the wall, but not nearer than the arc's gap; a side face's back edge is only as far as it is open.
  const back = face.greaterThan(0.5)
  const depth = select(back, select(isSide, t.mul(open), t), zero)
  const arc = front.sub(depth).max(gap)
  // The splash lies across the landing column (floor(ARC_GAP + r) out): ± its half extent about the landing point.
  const land = r.add(ARC_GAP)
  const landBase = land.floor()
  const flux = info.w
  const half = flux.max(0).sqrt().mul(SPLASH_PER_ROOT).min(SPLASH_MAX)
  const across = land.add(row.mul(half)).min(landBase.add(1)).max(landBase.max(ARC_GAP))
  const u = select(isSplash, across, arc)
  const y = top.sub(drop.mul(s.mul(s))).add(select(isSplash, float(SPLASH_LIFT), zero))
  const spread = flareAmount.mul(s)
  // Normal of the arc (u, y) = (r s, top − drop s²): perpendicular to its tangent (r, −2 drop s), facing out and up. With no
  // reach it faces straight out, like a flat curtain. The back face looks the other way.
  const out = drop.max(0).mul(s).mul(2).add(0.001)
  const arcNormal = normalize(vec3(ox.mul(out), r, oz.mul(out)))
  const faceNormal = select(back, arcNormal.mul(-1), arcNormal)
  const normal = select(isSplash, vec3(0, 1, 0), select(isSide, vec3(lx, 0, lz), faceNormal))
  const { sky, blk } = unpack(light)
  const fade = mix(float(0.45), float(1), smoothstep(0, 24, flux))
  // The splash shows at the ends that land on water, once the curtain has unrolled, and fades out toward its rows' edges.
  const wet = select(isB, water.div(2).floor(), water.sub(water.div(2).floor().mul(2)))
  const splash = fade.mul(wet).mul(drop.max(0).min(1)).mul(float(1).sub(row.abs()))
  return {
    position: vec3(info.x.add(select(isB, bx, ax)).add(ox.mul(u)).add(lx.mul(spread)), y, info.y.add(select(isB, bz, az)).add(oz.mul(u)).add(lz.mul(spread))),
    normal: varying(normal),
    isTop: varying(select(isSplash, one, zero)).greaterThan(0.5),
    sky, blk,
    flow: vec3(0, 0, 0),
    surface: float(1),
    white: varying(select(isSplash, one, smoothstep(8, 64, flux).mul(0.6))),
    fall: varying(float(1).add(flux.div(32).min(3))),
    alpha: varying(select(isSplash, splash, fade)),
  }
}
