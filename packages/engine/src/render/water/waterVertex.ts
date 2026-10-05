import type * as THREE from 'three/webgpu'
import { attribute, bool, float, instanceIndex, mix, normalize, select, smoothstep, step, uniform, varying, vec2, vec3 } from 'three/tsl'
import { chunkVertex } from '../chunkVertex.ts'
import { ARC_GAP, ARC_SEGMENTS, FLARE_OPEN_STEPS, LIP_UNITS, SLOPE_UNITS, SPLASH_LIFT, SPLASH_UNITS } from './surfaceMesh.ts'

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
 * - cInfo is (lipCode(lx, lip A), lipCode(lz, lip B), dir + 4 × (light + 256 × water), packFlux(flux, splash A, splash B)),
 *   water flagging (bit 0 A, bit 1 B) the ends that land on water, lip the depth (blocks) under the top at which an end's
 *   underside leaves the brink.
 * Each end's front point lies arcPoint(top, foot, reach, s) (surfaceMesh.ts) away: in front of the wall's plane along `dir`
 * (by ARC_GAP at least below the top, so it never meets the wall it pours from), and down from the top; its back point
 * backPoint(…, thick, s, lip) that much nearer the wall and lip · (1 − s)² lower. A flare (flareCode) says how open an end is and how far it moves out
 * along the edge (by its amount × s); an end shared with the curtain beside it is closed: it does not flare, and its side
 * face collapses (no seam where bodies join), both mixing smoothly with the other steps.
 * The splash is a white strip across the foot at the landing point, as wide as its end's speed gives it (its splash byte),
 * lying on the slope of the landing column's surface, fading out to its rows' edges, where the landing column is water and
 * the drawn foot has settled onto the current one.
 */
export function curtainVertex(): WaterVertex {
  // Branch-free on purpose: three's TSL compiles a select() into if/else and builds a node shared between its branches and
  // the rest of the graph where it first meets it, so a value first needed inside one branch (this end's light, the flux)
  // is left unset everywhere else (r186: a curtain's body read sky light 0 and drew black). Every choice below is a mix by
  // a 0/1 factor, so each value is computed once, for every vertex.
  const strip = attribute('strip', 'vec4')
  const cp = attribute('cPrev', 'vec4'), cc = attribute('cCur', 'vec4'), info = attribute('cInfo', 'vec4')
  const reach = attribute('cReach', 'vec4'), thick = attribute('cThick', 'vec4'), flare = attribute('cFlare', 'vec4')
  const a = waterAlpha
  const h = mix(cp, cc, a)
  const dir = info.z.mod(4)
  const lightWater = info.z.div(4).floor()
  const water = lightWater.div(256).floor()
  const light = lightWater.sub(water.mul(256))
  // 0/1 factors: this vertex's end is B; it is on a side face, on the splash, on the back face.
  const isB: N = strip.y
  const face = strip.z, kind = strip.w
  const isSplash: N = step(1.5, kind)
  const isSide: N = step(0.5, kind).sub(isSplash)
  const back: N = step(0.5, face)
  /** Per end: a at end A, b at end B. */
  const byEnd = (x: N, y: N): N => mix(x, y, isB)
  // The fall fraction (the splash lies at the foot) and the splash's row.
  const s = mix(strip.x, float(1), isSplash)
  const row = strip.x
  // cInfo.x / .y: the column's local x / z (0–31) + 32 × the brink depth of end A / B in 1/LIP_UNITS (lipCode).
  const localX = info.x.mod(32), localZ = info.y.mod(32)
  const lip = byEnd(info.x.sub(localX), info.y.sub(localZ)).div(32 * LIP_UNITS)
  const r = byEnd(mix(reach.x, reach.z, a), mix(reach.y, reach.w, a))
  const t = byEnd(mix(thick.x, thick.z, a), mix(thick.y, thick.w, a))
  // A flare is stored as round(open × 255) + amount (flareCode): both mix between the steps on their own.
  const flareP = byEnd(flare.x, flare.y), flareC = byEnd(flare.z, flare.w)
  const openP = flareP.floor(), openC = flareC.floor()
  const flareAmount = mix(flareP.sub(openP), flareC.sub(openC), a)
  const open = mix(openP, openC, a).div(FLARE_OPEN_STEPS)
  // info.w is the flux (below 256) + 256 × (splash byte of end A + 256 × the one of B): see packFlux, splashCode.
  const flux = info.w.mod(256)
  const splashes = info.w.sub(flux).div(256)
  const splashA = splashes.mod(256)
  const code = byEnd(splashA, splashes.sub(splashA).div(256))
  const codeLow = code.mod(16), codeSlope = code.sub(codeLow).div(16)
  const half = codeLow.div(SPLASH_UNITS)
  const slope = codeSlope.sub(step(8, codeSlope).mul(16)).div(SLOPE_UNITS)
  // One-hot direction (0 +x, 1 −x, 2 +z, 3 −z), then the edge's ends A (ax, az) and B (bx, bz) on the upper column's side.
  const e1: N = step(0.5, dir).sub(step(1.5, dir)), e2: N = step(1.5, dir).sub(step(2.5, dir)), e3: N = step(2.5, dir)
  const e0: N = float(1).sub(step(0.5, dir))
  const ax = e0.add(e2), az = e1.add(e2), bx = e0.add(e3), bz = e0.add(e2)
  // Outward: the direction the water leaves its column in; along: from this end out past the edge (the flare's direction).
  const ox = e0.sub(e1), oz = e2.sub(e3)
  const sign = float(1).sub(isB.mul(2))
  const lx = ax.sub(bx).mul(sign), lz = az.sub(bz).mul(sign)
  const top = byEnd(h.x, h.y), drop = top.sub(byEnd(h.z, h.w))
  const gap = s.mul(ARC_SEGMENTS).min(1).mul(ARC_GAP)
  const front = r.mul(s).add(gap)
  // The back face is `t` nearer the wall, but not nearer than the arc's gap; a side face's back edge is only as far as it is open.
  const depth = back.mul(mix(t, t.mul(open), isSide))
  // The underside leaves the brink lip under the top and closes in on the arc as it falls (a side face's as far as it is open).
  const fallLeft = float(1).sub(s)
  const under = back.mul(mix(float(1), open, isSide)).mul(lip).mul(fallLeft.mul(fallLeft))
  const arc = front.sub(depth).max(gap)
  // The splash lies across the landing column (floor(ARC_GAP + r) out): ± its half extent about the landing point.
  const land = r.add(ARC_GAP)
  const landBase = land.floor()
  const across = land.add(row.mul(half)).min(landBase.add(1)).max(landBase.max(ARC_GAP))
  const u = mix(arc, across, isSplash)
  // The splash lies on the surface of the landing column: the foot, then the slope along the fall from the landing point.
  const y = top.sub(drop.mul(s.mul(s))).sub(under).add(isSplash.mul(slope.mul(across.sub(land)).add(SPLASH_LIFT)))
  const spread = flareAmount.mul(s)
  // Normal of the arc (u, y) = (r s, top − drop s²): perpendicular to its tangent (r, −2 drop s), facing out and up. With no
  // reach it faces straight out, like a flat curtain. The back face looks the other way.
  const out = drop.max(0).mul(s).mul(2).add(0.001)
  const arcNormal = normalize(vec3(ox.mul(out), r, oz.mul(out)))
  const faceNormal = arcNormal.mul(float(1).sub(back.mul(2)))
  const normal = mix(mix(faceNormal, vec3(lx, 0, lz), isSide), vec3(0, 1, 0), isSplash)
  const { sky, blk } = unpack(light)
  const fade = mix(float(0.45), float(1), smoothstep(0, 24, flux))
  // The splash shows at the ends that land on water, once the curtain has unrolled, and fades out toward its rows' edges.
  const wetB = water.div(2).floor()
  const wet = byEnd(water.sub(wetB.mul(2)), wetB)
  // It also waits for the foot to settle: while the curtain unrolls (or the water under it moves) the drawn foot is far from
  // the current one, and a splash there would hang in the air.
  const footNow = byEnd(cc.z, cc.w), settled = float(1).sub(top.sub(drop).sub(footNow).abs().mul(4)).max(0)
  const splashFade = mix(float(0.45), float(1), half.div(0.4).min(1))
  const splash = splashFade.mul(wet).mul(drop.max(0).min(1)).mul(settled).mul(float(1).sub(row.abs()))
  return {
    position: vec3(localX.add(byEnd(ax, bx)).add(ox.mul(u)).add(lx.mul(spread)), y, localZ.add(byEnd(az, bz)).add(oz.mul(u)).add(lz.mul(spread))),
    normal: varying(normal),
    isTop: (varying(isSplash) as N).greaterThan(0.5),
    sky, blk,
    flow: vec3(0, 0, 0),
    surface: float(1),
    // A fall whitens as it goes down: it takes in air on the way.
    white: varying(mix(smoothstep(8, 64, flux).mul(s.mul(0.4).add(0.3)), float(1), isSplash)),
    fall: varying(float(1).add(flux.div(32).min(3))),
    alpha: varying(mix(fade, splash, isSplash)) as N,
  }
}
