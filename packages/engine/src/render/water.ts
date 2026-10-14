import * as THREE from 'three/webgpu'
import {
  abs, cameraFar, cameraNear, cameraPosition, dot, float, fract, max, mix, mx_noise_float, normalize, perspectiveDepthToViewZ,
  positionView, positionWorld, select, smoothstep, step, time, uniform, vec2, vec3, vec4, viewportDepthTexture,
} from 'three/tsl'
import { sunDirection, sunVisibility, type Atmosphere } from './atmosphere.ts'
import { setLinear } from './lighting.ts'
import type { WaterParams } from './settings.ts'
import { VoxelNodeMaterial, voxelLit, type LightUniforms } from './voxelLighting.ts'
import { rippleEffect, tiltedNormal } from './water/ripples.ts'
import { curtainVertex, surfaceVertex, voidFloor, voxelWaterVertex, type WaterVertex } from './water/waterVertex.ts'

type N = ReturnType<typeof float>
type V2 = THREE.Node<'vec2'>
const EPS = 0.08
const RIPPLE = 0.15
/** Blocks per second the ripples travel along the flow at speed 1. */
const FLOW_SPEED = 1.2
/** How far (blocks) a flow ripple sample drifts before it fades out and restarts: the drift never exceeds it. */
const FLOW_PERIOD = 1.5
/** The water depth (blocks) a curtain's colour is taken at: a thin falling sheet, shallow-coloured whatever lies behind it. */
const CURTAIN_DEPTH = 0.4
/** Blocks per second the streaks run down a curtain at fall factor 1 (WaterVertex.fall: 1 to 4 with the flux). */
const CURTAIN_FALL_SPEED = 2.5
/** How white a curtain's aerated streaks get at most. */
const CURTAIN_STREAK = 0.55

function createUniforms() {
  return {
    shallow: uniform(new THREE.Color()),
    deep: uniform(new THREE.Color()),
    depthScale: uniform(3),
    foamWidth: uniform(0.5),
    waveScale: uniform(0.35),
    waveSpeed: uniform(0.6),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
    sunColor: uniform(new THREE.Color()),
    /** sunVisibility(elevation) × min(intensity, 1): no glint once the sun has set. */
    sunVis: uniform(1),
    horizon: uniform(new THREE.Color()),
  }
}
type WaterUniforms = ReturnType<typeof createUniforms>

/**
 * Ripples, depth colour, shore foam, white water, sun glint and sky fresnel, for any water vertex source. A curtain has air
 * behind it, not water: it gets no depth colour or shore foam (the scene behind a waterfall is metres away and would paint it
 * deep-water dark), but aerated streaks running down it instead.
 */
function shade(m: VoxelNodeMaterial, v: WaterVertex, u: WaterUniforms, lights: LightUniforms, depthEffects: boolean, edits = false, curtain = false): void {
  m.positionNode = v.position
  m.transparent = true
  m.depthWrite = false
  const wp = positionWorld
  const speed = time.mul(u.waveSpeed)
  const h = (p: V2) => mx_noise_float(vec3(p.mul(u.waveScale).add(vec2(speed, speed.mul(0.6))), time.mul(0.25)))
    .add(mx_noise_float(vec3(p.mul(u.waveScale.mul(2.3)).sub(vec2(speed.mul(0.7), 0)), time.mul(0.4))).mul(0.5))
  // Flow map with two phases: two ripple samples drift along the flow, half a period apart, by at most FLOW_PERIOD
  // blocks, and each fades out (triangle weight) as it wraps back. Still water (flow 0) has no drift.
  const phase = fract(time.mul(v.flow.z).mul(FLOW_SPEED / FLOW_PERIOD))
  const dir = vec2(v.flow.x, v.flow.y).mul(FLOW_PERIOD)
  const slope = (q: V2) => {
    const h0 = h(q)
    return vec2(h0.sub(h(q.add(vec2(EPS, 0)))), h0.sub(h(q.add(vec2(0, EPS)))))
  }
  const g = mix(slope(wp.xz.sub(dir.mul(phase))), slope(wp.xz.sub(dir.mul(fract(phase.add(0.5))))), abs(phase.mul(2).sub(1)))
  const ripple = normalize(vec3(g.x.mul(RIPPLE / EPS), 1, g.y.mul(RIPPLE / EPS)))
  // Ripples ride on the surface's own tilt (a river ramp); on flat water v.normal is straight up and this is the ripple.
  // Ripples from block edits at the water line tilt the surface (the heightfield's only) and whiten the first ring's crest.
  const edit = edits ? rippleEffect(wp) : null
  const flat = normalize(ripple.add(v.normal).sub(vec3(0, 1, 0)))
  const n = select(v.isTop, edit ? tiltedNormal(flat, edit) : flat, v.normal)

  const thickness = curtain ? float(CURTAIN_DEPTH) : depthEffects
    ? positionView.z.sub(perspectiveDepthToViewZ(viewportDepthTexture(), cameraNear, cameraFar)).max(0)
    : float(2)
  const depthT = float(1).sub(thickness.div(u.depthScale).negate().exp())
  const drift = time.mul(0.35)
  const foamNoise = mx_noise_float(vec3(wp.xz.mul(1.6).add(vec2(drift, drift.mul(0.5))), time.mul(0.3)))
    .add(mx_noise_float(vec3(wp.xz.mul(3.1).sub(vec2(drift.mul(0.6), drift.mul(1.2))), time.mul(0.45))))
    .mul(0.25).add(0.5)
  const fw = max(u.foamWidth, 1e-3)
  const band = float(1).sub(smoothstep(0, max(u.foamWidth.mul(foamNoise.mul(0.8).add(0.6)), 1e-3), thickness))
  const lap = smoothstep(0.75, 1.0, fract(thickness.div(fw.mul(1.6)).add(time.mul(0.35)).add(foamNoise.mul(0.3))))
    .mul(float(1).sub(smoothstep(0, fw.mul(3), thickness)))
  const foam = depthEffects && !curtain ? max(band, lap.mul(0.7)).mul(step(1e-4, u.foamWidth)).mul(smoothstep(0.2, 0.6, v.surface)) : float(0)
  // White water breaks up with the same noise as the foam, so fast water churns rather than turning flat white.
  const streaks = max(foam, v.white.mul(foamNoise.mul(0.6).add(0.55)).min(1))
  // A curtain's aerated streaks: noise stretched down the fall (fine across it, long along it) scrolling down at its speed.
  const along = wp.x.add(wp.z), down = wp.y.add(time.mul(v.fall).mul(CURTAIN_FALL_SPEED))
  const aerated = smoothstep(0.05, 0.55, mx_noise_float(vec3(along.mul(2.3), down.mul(0.22), 0.5))
    .add(mx_noise_float(vec3(along.mul(5.3), down.mul(0.45), 1.7)).mul(0.5)))
  const fallWhite = curtain ? max(streaks, aerated.mul(CURTAIN_STREAK)) : streaks
  const white = edit ? max(fallWhite, edit.z) : fallWhite
  const streak = select(v.isTop, float(0), mx_noise_float(vec3(along.mul(0.9), wp.y.mul(0.6).add(speed.mul(3).mul(v.fall)), 0)).mul(0.12))
  const albedo = mix(mix(u.shallow, u.deep, depthT).add(curtain ? float(0) : streak), vec3(1), white)
  const opacity = curtain ? mix(float(0.7), float(0.95), white) : mix(mix(float(0.66), float(0.94), depthT), float(1), white)
  m.colorNode = vec4(albedo, opacity.mul(v.alpha))
  voxelLit(m, { normal: n, sky: v.sky, blk: v.blk, ao: float(1), albedo }, lights)

  const view = cameraPosition.sub(wp).normalize()
  const half = normalize(view.add(u.sunDir))
  const spec = dot(n, half).max(0).pow(160).mul(2.5).mul(smoothstep(0.35, 0.95, v.sky)).mul(u.sunVis)
  const fresnel = float(1).sub(dot(n, view).max(0)).pow(4).mul(0.35)
  m.emissiveNode = (m.emissiveNode as N).add(u.sunColor.mul(spec)).add(u.horizon.mul(fresnel))
}

/** Translucent flat-coloured water for when the water effect is off. */
function plain(v: WaterVertex, u: WaterUniforms, lights: LightUniforms): VoxelNodeMaterial {
  const m = new VoxelNodeMaterial(v.sky)
  m.positionNode = v.position
  m.transparent = true
  m.depthWrite = false
  voxelLit(m, { normal: v.normal, sky: v.sky, blk: v.blk, ao: float(1), albedo: u.shallow }, lights)
  m.colorNode = vec4(u.shallow, float(0.8).mul(v.alpha))
  return m
}

/** The water materials: static voxel water (the chunk liquid layer), the heightfield surface and its curtains, plus plain fallbacks. */
export class WaterMaterial {
  readonly voxel: VoxelNodeMaterial
  readonly surface: VoxelNodeMaterial
  readonly curtain: VoxelNodeMaterial
  readonly plainSurface: VoxelNodeMaterial
  readonly plainCurtain: VoxelNodeMaterial
  private readonly u = createUniforms()

  constructor(lights: LightUniforms, depthEffects: boolean) {
    const make = (v: WaterVertex, edits = false, curtain = false): VoxelNodeMaterial => {
      const m = new VoxelNodeMaterial(v.sky)
      shade(m, v, this.u, lights, depthEffects, edits, curtain)
      return m
    }
    this.voxel = make(voxelWaterVertex())
    this.surface = make(surfaceVertex(), true)
    this.curtain = make(curtainVertex(), false, true)
    this.curtain.side = THREE.FrontSide
    this.plainSurface = plain(surfaceVertex(), this.u, lights)
    this.plainCurtain = plain(curtainVertex(), this.u, lights)
    this.plainCurtain.side = THREE.FrontSide
  }

  setParams(p: WaterParams): void {
    setLinear(this.u.shallow.value, p.shallow)
    setLinear(this.u.deep.value, p.deep)
    this.u.depthScale.value = p.depthScale
    this.u.foamWidth.value = p.foamWidth
    this.u.waveScale.value = p.waveScale
    this.u.waveSpeed.value = p.waveSpeed
  }

  /** Void world (spec §3): curtains fade out toward the bottom of the volume. */
  setVoidFloor(v: boolean): void { voidFloor.value = v ? 1 : 0 }

  applyAtmosphere(a: Atmosphere): void {
    const [x, y, z] = sunDirection(a.sun.azimuth, a.sun.elevation)
    this.u.sunDir.value.set(x, y, z)
    setLinear(this.u.sunColor.value, a.sun.color)
    this.u.sunVis.value = sunVisibility(a.sun.elevation) * Math.min(a.sun.intensity, 1)
    setLinear(this.u.horizon.value, a.sky.horizon)
  }

  dispose(): void {
    for (const m of [this.voxel, this.surface, this.curtain, this.plainSurface, this.plainCurtain]) m.dispose()
  }
}
