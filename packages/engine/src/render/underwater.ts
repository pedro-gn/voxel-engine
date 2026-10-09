import * as THREE from 'three/webgpu'
import { cos, exp, mix, sin, time, uniform, uv, vec2 } from 'three/tsl'
import type { pass } from 'three/tsl'
import type { Collision } from '../interact/collision.ts'
import type { Rgb } from './atmosphere.ts'
import { setLinear } from './lighting.ts'

/** The underwater view's feel numbers (spec 4d §3 "Underwater view"); all go to the user's visual checkpoint. */
export const UNDERWATER = Object.freeze({
  /** Seconds to fade fully in or out. */
  fade: 0.1,
  /** Blocks at which the fog has covered 90 % of the scene. */
  fog90: 12,
  /** How far the shallow-water colour tints the picture: 0 none, 1 a full multiply. */
  tint: 0.6,
  /** Peak UV offset of the wobble at full amount (user look check: 0.003 was much too strong). */
  wobble: 0.001,
  /** Wobble phase speed, rad/s (the second axis runs at 0.8×); low, so moving under water does not feel swimmy. */
  wobbleSpeed: 0.8,
})

/** Fog density k such that 1 − e^(−k·d) = 0.9 at d = distance90. */
export function fogDensity(distance90: number): number {
  return Math.LN10 / distance90
}

/**
 * Whether the camera at (x, y, z) is under a liquid surface (the voxel water level, not the animated surface).
 * Skipped without a query when the registry has no liquid block; collision.liquidAt is false outside the world.
 */
export function cameraInLiquid(collision: Pick<Collision, 'liquidAt'>, liquid: Uint8Array, x: number, y: number, z: number): boolean {
  return liquid.includes(1) && collision.liquidAt(x, y, z)
}

/** The underwater view's 0–1 amount: a linear ramp over `fade` seconds that reaches exactly 0 and 1. */
export class UnderwaterFade {
  amount = 0
  private readonly fade: number

  constructor(fade: number = UNDERWATER.fade) {
    this.fade = fade
  }

  update(rawDt: number, under: boolean): number {
    const dt = Number.isFinite(rawDt) ? Math.min(0.1, Math.max(0, rawDt)) : 0
    const target = under ? 1 : 0
    if (!(this.fade > 0)) this.amount = target
    else if (this.amount < target) this.amount = Math.min(1, this.amount + dt / this.fade)
    else if (this.amount > target) this.amount = Math.max(0, this.amount - dt / this.fade)
    return this.amount
  }
}

export type UnderwaterUniforms = ReturnType<typeof createUnderwaterUniforms>

export function createUnderwaterUniforms() {
  return {
    amount: uniform(0),
    density: uniform(fogDensity(UNDERWATER.fog90)),
    wobble: uniform(UNDERWATER.wobble),
    /** Fog colour: the deep-water colour. */
    fog: uniform(new THREE.Color(0, 0, 0)),
    /** Multiplier: white mixed towards the shallow-water colour by UNDERWATER.tint. */
    tint: uniform(new THREE.Color(1, 1, 1)),
  }
}

/** Sets the amount and takes the colours from the water parameters (so setWater restyles the view). */
export function setUnderwater(u: UnderwaterUniforms, amount: number, water: { shallow: Rgb; deep: Rgb }): void {
  u.amount.value = amount
  setLinear(u.fog.value, water.deep)
  const s = water.shallow, k = UNDERWATER.tint
  u.tint.value.setRGB(1 + (s[0] - 1) * k, 1 + (s[1] - 1) * k, 1 + (s[2] - 1) * k, THREE.LinearSRGBColorSpace)
}

/**
 * The scene colour with the underwater view applied by u.amount. Branch-free (no select, see the TSL select bug):
 * at amount 0 the UV offset is 0 and the mix returns the scene colour unchanged.
 */
export function underwaterColor(scenePass: ReturnType<typeof pass>, u: UnderwaterUniforms) {
  const base = uv()
  const w = u.amount.mul(u.wobble)
  const t = time.mul(UNDERWATER.wobbleSpeed)
  const offset = vec2(sin(base.y.mul(40).add(t)), cos(base.x.mul(32).add(t.mul(0.8)))).mul(w)
  const scene = scenePass.getTextureNode().sample(base.add(offset)).rgb
  const distance = scenePass.getViewZNode().negate().max(0)
  const fogged = mix(scene, u.fog, exp(distance.mul(u.density).negate()).oneMinus())
  return mix(scene, fogged.mul(u.tint), u.amount)
}
