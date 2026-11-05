import { float, floor, int, ivec2, mix, sin, textureLoad, time, vec2, vec3 } from 'three/tsl'
import { windMaskTexture, type DecorationWind } from './decorations/windMask.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any // TSL node typings are too narrow for swizzles and uniform-array elements

/** The leaves' horizontal sway, in blocks: at strength 0 (and in full shelter) … at a gale on fully exposed ground. */
export const LEAF_SWAY_CALM = 0.02
export const LEAF_SWAY_GALE = 0.12
/** The vertical bob as a share of the horizontal sway. */
export const LEAF_SWAY_VERTICAL = 0.15

/** The leaves' sway amplitude in blocks for a wind strength (0–1) and an exposure (0–1); the shader computes the same. */
export function swayAmplitude(strength: number, exposure: number): number {
  return LEAF_SWAY_CALM + (LEAF_SWAY_GALE - LEAF_SWAY_CALM) * strength * exposure
}

/**
 * The world-space offset of a swaying vertex (BlockDef.sway) at its undisplaced world position `world`, `amount` its
 * layer's sway (0 = still). A smooth function of position and time only, so every vertex at one point moves alike (no
 * cracks between faces, strips and merged quads: its wavelengths are tens of blocks, so it stays nearly linear across a
 * merged quad), on TSL `time` like the grass (real time: it keeps moving while the game is paused).
 *
 * Along the wind it leans downwind and rebounds a little (−0.3 … 1 × amplitude), across it flutters (±0.3), and it bobs
 * up and down by LEAF_SWAY_VERTICAL of the amplitude. The amplitude is swayAmplitude(strength, exposure) with the
 * exposure read bilinearly between the wind mask's cell centres, so it never steps at a cell border.
 */
export function leafSwayOffset(world: N, amount: N, wind: DecorationWind): N {
  const mask = wind.mask, tex = windMaskTexture(mask), last = mask.side - 1
  const c: N = (world.xz as N).div(mask.cell).sub(0.5)
  const i0: N = floor(c), f: N = c.sub(i0)
  const at = (dx: number, dz: number): N => (textureLoad(tex, ivec2(
    (int(i0.x.add(dx)) as N).clamp(0, last), (int(i0.y.add(dz)) as N).clamp(0, last),
  )) as N).x
  const exposure: N = mix(mix(at(0, 0), at(1, 0), f.x), mix(at(0, 1), at(1, 1), f.x), f.y)
  const strength: N = wind.strength, dir: N = wind.dir
  const amp: N = float(LEAF_SWAY_CALM).add(strength.mul(LEAF_SWAY_GALE - LEAF_SWAY_CALM).mul(exposure)).mul(amount)
  // Two slow travelling waves on fixed world axes (a change of wind direction turns the sway, it does not jump its phase).
  const p: N = world.x.mul(0.11).add(world.z.mul(0.07)).add(world.y.mul(0.08)).sub(time.mul(1.3))
  const q: N = world.x.mul(-0.09).add(world.z.mul(0.17)).add(world.y.mul(0.13)).add(time.mul(2.1))
  const along: N = sin(p).mul(0.65).add(0.35)
  const across: N = sin(q).mul(0.3)
  const h: N = dir.mul(along).add(vec2(dir.y.negate(), dir.x).mul(across)).mul(amp)
  const up: N = (sin(p.add(q)) as N).mul(LEAF_SWAY_VERTICAL).mul(amp)
  return vec3(h.x, up, h.y)
}
