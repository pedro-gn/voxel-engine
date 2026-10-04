import type * as THREE from 'three/webgpu'
import { attribute, bool, float, instanceIndex, mix, normalize, select, smoothstep, uniform, varying, vec2, vec3 } from 'three/tsl'
import { chunkVertex } from '../chunkVertex.ts'

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

/** Static voxel water: the chunk liquid layer's packed vertex. */
export function voxelWaterVertex(): WaterVertex {
  const v = chunkVertex(undefined, true)
  return {
    position: v.position, normal: v.normal, isTop: v.normal.y.greaterThan(0.5), sky: v.sky, blk: v.blk,
    flow: v.flow, surface: v.surface, white: float(0), fall: float(1).add(v.flow.z.mul(2)), alpha: float(1),
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
 * A waterfall curtain (WaterSurface): one instanced quad per curtain.
 * - The base quad's `corner` (0 top A, 1 top B, 2 bottom B, 3 bottom A) picks a height from cPrev/cCur (top A, top B, bottom A, bottom B).
 * - cInfo is (lx, lz, dir + 4 × light, flux).
 * - The edge's ends A and B sit on the upper column's side `dir` (0 +x, 1 −x, 2 +z, 3 −z).
 */
export function curtainVertex(): WaterVertex {
  const corner = attribute('corner', 'float')
  const cp = attribute('cPrev', 'vec4'), cc = attribute('cCur', 'vec4'), info = attribute('cInfo', 'vec4')
  const h = mix(cp, cc, waterAlpha)
  const dir = info.z.mod(4)
  const light = info.z.div(4).floor()
  const isB = corner.greaterThan(0.5).and(corner.lessThan(2.5))
  const top = corner.lessThan(1.5)
  const d0 = dir.lessThan(0.5), d1 = dir.lessThan(1.5), d2 = dir.lessThan(2.5)
  const one = float(1), zero = float(0)
  const ax = select(d0, one, select(d1, zero, select(d2, one, zero)))
  const az = select(d0, zero, select(d1, one, select(d2, one, zero)))
  const bx = select(d0, one, select(d1, zero, select(d2, zero, one)))
  const bz = select(d0, one, select(d1, zero, select(d2, one, zero)))
  const y = select(top, select(isB, h.y, h.x), select(isB, h.w, h.z))
  const normal = select(d0, vec3(1, 0, 0), select(d1, vec3(-1, 0, 0), select(d2, vec3(0, 0, 1), vec3(0, 0, -1))))
  const { sky, blk } = unpack(light)
  const flux = info.w
  return {
    position: vec3(info.x.add(select(isB, bx, ax)), y, info.y.add(select(isB, bz, az))),
    normal: varying(normal),
    isTop: bool(false),
    sky, blk,
    flow: vec3(0, 0, 0),
    surface: float(1),
    white: varying(smoothstep(8, 64, flux).mul(0.6)),
    fall: varying(float(1).add(flux.div(32).min(3))),
    alpha: varying(mix(float(0.45), float(1), smoothstep(0, 24, flux))),
  }
}
