import * as THREE from 'three/webgpu'
import { Fn, If, exp, float, max, normalize, step, uniform, uniformArray, vec2, vec3 } from 'three/tsl'
import type { SurfaceView } from './surfaceView.ts'

/** Loose TSL node type (see voxelLighting.ts). */
type N = any

/** Ripples that can be alive at once: the oldest is replaced by a new one beyond that. */
export const RIPPLE_CAPACITY = 16
/** Seconds a ripple lives, and the radius (blocks) its outermost ring reaches in that time. */
export const RIPPLE_LIFE = 1.2
export const RIPPLE_RADIUS = 4
/** An edit counts when the block's vertical span is within this many blocks of a water surface beside it. */
export const RIPPLE_RANGE = 1
/** Rings of a ripple, the gap (blocks) between them, and the width σ (blocks) of one. */
const RINGS = 3
const RING_GAP = 0.9
const RING_WIDTH = 0.18
/** How high (blocks) the first ring stands: its slope tilts the surface's normal; the others are weaker. */
const RING_HEIGHT = 0.06

/** Rings draw on water within this many blocks (vertically) of the surface the edit was at: see rippleHeightWeight. */
export const RIPPLE_HEIGHT = 0.5
/** A region edit rings at most this many cells of its shell, at least RIPPLE_SPACING blocks apart. */
export const REGION_RIPPLES = 4
export const RIPPLE_SPACING = 3

/** How much a ripple whose surface is `dy` blocks away vertically (above or below) shows there: 1 at the surface, 0 from RIPPLE_HEIGHT. */
export function rippleHeightWeight(dy: number): number {
  return Math.max(0, 1 - Math.abs(dy) / RIPPLE_HEIGHT)
}

/**
 * The water surface (blocks) a block edited at (x, y, z) is at, or null if it is not at a water line: its vertical span (y to
 * y + 1) lies within RIPPLE_RANGE of the surface of its own column or of one of its four neighbours, as last published (the
 * one nearest the block when several are). A block dropped in or pulled out of the surface counts; a deck a few blocks above
 * the lake, or a block far under it, does not.
 */
export function waterLineSurface(view: SurfaceView, x: number, y: number, z: number): number | null {
  let best: number | null = null
  for (let k = 0; k < 5; k++) {
    const s = view.surfaceAt(k === 1 ? x - 1 : k === 2 ? x + 1 : x, k === 3 ? z - 1 : k === 4 ? z + 1 : z)
    if (s === null || Math.max(0, y - s, s - (y + 1)) > RIPPLE_RANGE) continue
    if (best === null || Math.abs(s - (y + 0.5)) < Math.abs(best - (y + 0.5))) best = s
  }
  return best
}

/** Whether a block edited at (x, y, z) is at a water line (see waterLineSurface). */
export function atWaterLine(view: SurfaceView, x: number, y: number, z: number): boolean {
  return waterLineSurface(view, x, y, z) !== null
}

/** The commands editRipples looks at. */
export type EditCommand =
  | { type: 'setBlock'; pos: readonly [number, number, number]; voxel: number }
  | { type: 'fillRegion'; min: readonly [number, number, number]; max: readonly [number, number, number]; voxel: number }

/**
 * Starts the ripples of an edit: a `setBlock` rings at its block if that is at a water line; a `fillRegion` at the water-line
 * cells of its shell (the region's sides), spaced RIPPLE_SPACING apart and at most REGION_RIPPLES of them, so one edit cannot
 * take the whole pool. An edit that changes nothing (`get` already gives its voxel there) rings nothing.
 */
export function editRipples(view: SurfaceView, set: RippleSet, cmd: EditCommand, get: (x: number, y: number, z: number) => number): void {
  if (cmd.type === 'setBlock') {
    const [x, y, z] = cmd.pos
    if (get(x, y, z) === cmd.voxel) return
    const s = waterLineSurface(view, x, y, z)
    if (s !== null) set.add(x + 0.5, z + 0.5, s)
    return
  }
  const [x0, y0, z0] = cmd.min, [x1, y1, z1] = cmd.max
  let n = 0
  const cx: number[] = [], cz: number[] = []
  for (let z = z0; z <= z1 && n < REGION_RIPPLES; z++) for (let x = x0; x <= x1 && n < REGION_RIPPLES; x++) {
    if (x !== x0 && x !== x1 && z !== z0 && z !== z1) continue
    if (cx.some((px, i) => Math.hypot(px - x, cz[i]! - z) < RIPPLE_SPACING)) continue
    const s = view.surfaceAt(x, z)
    if (s === null) continue
    for (let y = Math.max(y0, Math.ceil(s - 1 - RIPPLE_RANGE)); y <= Math.min(y1, Math.floor(s + RIPPLE_RANGE)); y++) {
      if (get(x, y, z) === cmd.voxel) continue
      const at = waterLineSurface(view, x, y, z)
      if (at === null) continue
      set.add(x + 0.5, z + 0.5, at)
      cx.push(x)
      cz.push(z)
      n++
      break
    }
  }
}

/** The live ripples: the centre (x, z) of each in the first `count` slots, its surface height y, and the clock time it started. */
export class RippleSet {
  count = 0
  readonly x = new Float32Array(RIPPLE_CAPACITY)
  readonly z = new Float32Array(RIPPLE_CAPACITY)
  readonly y = new Float32Array(RIPPLE_CAPACITY)
  readonly start = new Float32Array(RIPPLE_CAPACITY)
  /** The frame clock (seconds): the sum of the frames' dts, back to 0 whenever no ripple is alive (it never drifts in float). */
  now = 0

  /** Starts a ripple at (x, z) on the water surface at height y, replacing the oldest when the pool is full. */
  add(x: number, z: number, y: number): void {
    let slot = this.count
    if (slot === RIPPLE_CAPACITY) {
      slot = 0
      for (let i = 1; i < this.count; i++) if (this.start[i]! < this.start[slot]!) slot = i
    } else this.count++
    this.x[slot] = x
    this.z[slot] = z
    this.y[slot] = y
    this.start[slot] = this.now
  }

  /** How much ripple i shows on water at height wy (rippleHeightWeight of its distance from the ripple's surface). */
  weightAt(i: number, wy: number): number { return rippleHeightWeight(wy - this.y[i]!) }

  /** Advances the clock by one frame and drops the ripples that have run their course. */
  update(dt: number): void {
    this.now += dt
    let w = 0
    for (let i = 0; i < this.count; i++) {
      if (this.now - this.start[i]! >= RIPPLE_LIFE) continue
      this.x[w] = this.x[i]!
      this.z[w] = this.z[i]!
      this.y[w] = this.y[i]!
      this.start[w] = this.start[i]!
      w++
    }
    this.count = w
    if (w === 0) this.now = 0
  }
}

/** The ripples every water surface draws (see rippleEffect). */
export const ripples = new RippleSet()

/** Shader side: the pool's slots (x, z, start, y), how many are live, and the clock. Written by `syncRipples`. */
const slots = uniformArray(Array.from({ length: RIPPLE_CAPACITY }, () => new THREE.Vector4()), 'vec4')
const live = uniform(0)
const clock = uniform(0)

/** Copies the pool into the shader's uniforms: call once per frame. */
export function syncRipples(set: RippleSet = ripples): void {
  const a = slots.array as THREE.Vector4[]
  for (let i = 0; i < set.count; i++) a[i]!.set(set.x[i]!, set.z[i]!, set.start[i]!, set.y[i]!)
  live.value = set.count
  clock.value = set.now
}

/**
 * The ripples at a world position (xz): `.xy` the tilt to add to the surface's normal (x, z) and `.z` the white of the first
 * ring's crest. Each live ripple is RINGS gaussian rings expanding from the centre of the block to RIPPLE_RADIUS over
 * RIPPLE_LIFE, fading out, and hidden over the block's own footprint. Skipped altogether with no live ripple.
 */
export function rippleEffect(wp: THREE.Node<'vec3'>): THREE.Node<'vec3'> {
  const xz: N = wp.xz
  return Fn(() => {
    const tilt = vec2(0, 0).toVar(), crest = float(0).toVar()
    If(live.greaterThan(0.5), () => {
      for (let i = 0; i < RIPPLE_CAPACITY; i++) {
        If(live.greaterThan(i + 0.5), () => {
          const e: N = slots.element(i)
          const d = xz.sub(e.xy), dist = d.length().max(0.001)
          const life = clock.sub(e.z).div(RIPPLE_LIFE)
          // Only water at the height of the edit: a lower or higher pool within the radius shows nothing.
          const level = float(1).sub(wp.y.sub(e.w).abs().div(RIPPLE_HEIGHT)).max(0)
          const fade = float(1).sub(life).max(0).pow(2).mul(step(0, life)).mul(level)
          const outside = step(0.5, max(d.x.abs(), d.y.abs())) // not over the edited block
          for (let j = 0; j < RINGS; j++) {
            const off = dist.sub(life.mul(RIPPLE_RADIUS).sub(j * RING_GAP))
            const g = exp(off.mul(off).div(-2 * RING_WIDTH * RING_WIDTH))
            const weight = fade.mul(outside).mul(1 - 0.3 * j)
            tilt.addAssign(d.div(dist).mul(off.mul(g).mul(weight).mul(RING_HEIGHT / (RING_WIDTH * RING_WIDTH))))
            if (j === 0) crest.addAssign(g.mul(weight).mul(0.55)) // a faint crest
          }
        })
      }
    })
    return vec3(tilt, crest.min(1))
  })() as THREE.Node<'vec3'>
}

/** The normal of a flat surface tilted by `rippleEffect(...).xy`. */
export function tiltedNormal(base: THREE.Node<'vec3'>, effect: THREE.Node<'vec3'>): THREE.Node<'vec3'> {
  return normalize(base.add(vec3(effect.x, 0, effect.y))) as THREE.Node<'vec3'>
}

