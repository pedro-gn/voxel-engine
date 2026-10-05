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

/**
 * Whether a block edited at (x, y, z) is at a water line: its vertical span (y to y + 1) lies within RIPPLE_RANGE of the water
 * surface of its own column or of one of its four neighbours, as last published. A block dropped in or pulled out of the
 * surface counts; a deck a few blocks above the lake, or a block far under it, does not.
 */
export function atWaterLine(view: SurfaceView, x: number, y: number, z: number): boolean {
  for (let k = 0; k < 5; k++) {
    const s = view.surfaceAt(k === 1 ? x - 1 : k === 2 ? x + 1 : x, k === 3 ? z - 1 : k === 4 ? z + 1 : z)
    if (s !== null && Math.max(0, y - s, s - (y + 1)) <= RIPPLE_RANGE) return true
  }
  return false
}

/** The live ripples: the centre (x, z) of each in the first `count` slots, and the clock time it started. */
export class RippleSet {
  count = 0
  readonly x = new Float32Array(RIPPLE_CAPACITY)
  readonly z = new Float32Array(RIPPLE_CAPACITY)
  readonly start = new Float32Array(RIPPLE_CAPACITY)
  /** The frame clock (seconds): the sum of the frames' dts. */
  now = 0

  /** Starts a ripple at (x, z), replacing the oldest when the pool is full. */
  add(x: number, z: number): void {
    let slot = this.count
    if (slot === RIPPLE_CAPACITY) {
      slot = 0
      for (let i = 1; i < this.count; i++) if (this.start[i]! < this.start[slot]!) slot = i
    } else this.count++
    this.x[slot] = x
    this.z[slot] = z
    this.start[slot] = this.now
  }

  /** Advances the clock by one frame and drops the ripples that have run their course. */
  update(dt: number): void {
    this.now += dt
    let w = 0
    for (let i = 0; i < this.count; i++) {
      if (this.now - this.start[i]! >= RIPPLE_LIFE) continue
      this.x[w] = this.x[i]!
      this.z[w] = this.z[i]!
      this.start[w] = this.start[i]!
      w++
    }
    this.count = w
  }
}

/** The ripples every water surface draws (see rippleEffect). */
export const ripples = new RippleSet()

/** Shader side: the pool's slots (x, z, start), how many are live, and the clock. Written by `syncRipples`. */
const slots = uniformArray(Array.from({ length: RIPPLE_CAPACITY }, () => new THREE.Vector3()), 'vec3')
const live = uniform(0)
const clock = uniform(0)

/** Copies the pool into the shader's uniforms: call once per frame. */
export function syncRipples(set: RippleSet = ripples): void {
  const a = slots.array as THREE.Vector3[]
  for (let i = 0; i < set.count; i++) a[i]!.set(set.x[i]!, set.z[i]!, set.start[i]!)
  live.value = set.count
  clock.value = set.now
}

/**
 * The ripples at a world position (xz): `.xy` the tilt to add to the surface's normal (x, z) and `.z` the white of the first
 * ring's crest. Each live ripple is RINGS gaussian rings expanding from the centre of the block to RIPPLE_RADIUS over
 * RIPPLE_LIFE, fading out, and hidden over the block's own footprint. Skipped altogether with no live ripple.
 */
export function rippleEffect(xz: THREE.Node<'vec2'>): THREE.Node<'vec3'> {
  return Fn(() => {
    const tilt = vec2(0, 0).toVar(), crest = float(0).toVar()
    If(live.greaterThan(0.5), () => {
      for (let i = 0; i < RIPPLE_CAPACITY; i++) {
        If(live.greaterThan(i + 0.5), () => {
          const e: N = slots.element(i)
          const d = xz.sub(e.xy), dist = d.length().max(0.001)
          const life = clock.sub(e.z).div(RIPPLE_LIFE)
          const fade = float(1).sub(life).max(0).pow(2).mul(step(0, life))
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

