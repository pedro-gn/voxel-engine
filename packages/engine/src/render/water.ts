import * as THREE from 'three/webgpu'
import {
  abs, cameraFar, cameraNear, cameraPosition, dot, float, fract, max, mix, mx_noise_float, normalize, perspectiveDepthToViewZ,
  positionView, positionWorld, select, smoothstep, step, time, uniform, vec2, vec3, vec4, viewportDepthTexture,
} from 'three/tsl'
import { sunDirection, sunVisibility, type Atmosphere } from './atmosphere.ts'
import { chunkVertex } from './chunkVertex.ts'
import { setLinear } from './lighting.ts'
import type { WaterParams } from './settings.ts'
import { VoxelNodeMaterial, voxelLit, type LightUniforms } from './voxelLighting.ts'

type N = ReturnType<typeof float>
type V2 = THREE.Node<'vec2'>
const EPS = 0.08
const RIPPLE = 0.15
/** Blocks per second the ripples travel along the flow at speed 1. */
const FLOW_SPEED = 1.2
/** How far (blocks) a flow ripple sample drifts before it fades out and restarts: the drift never exceeds it. */
const FLOW_PERIOD = 1.5

/** The liquid layer's material: ripples, depth colour, shore foam, sun glint and sky fresnel. */
export class WaterMaterial {
  readonly material: VoxelNodeMaterial
  private readonly u = {
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

  constructor(lights: LightUniforms, depthEffects: boolean) {
    const u = this.u
    const v = chunkVertex(undefined, true)
    const m = new VoxelNodeMaterial(v.sky)
    m.positionNode = v.position
    m.transparent = true
    m.depthWrite = false
    const wp = positionWorld
    const isTop = v.normal.y.greaterThan(0.5)
    const speed = time.mul(u.waveSpeed)
    const h = (p: V2) => mx_noise_float(vec3(p.mul(u.waveScale).add(vec2(speed, speed.mul(0.6))), time.mul(0.25)))
      .add(mx_noise_float(vec3(p.mul(u.waveScale.mul(2.3)).sub(vec2(speed.mul(0.7), 0)), time.mul(0.4))).mul(0.5))
    // Flow map with two phases: two ripple samples drift along the flow, half a period apart, by at most
    // FLOW_PERIOD blocks, and each fades out (triangle weight) as it wraps back. The drift stays bounded, so
    // faces with different flow never drift apart by more than a period. Still water (flow 0) has no drift.
    const phase = fract(time.mul(v.flow.z).mul(FLOW_SPEED / FLOW_PERIOD))
    const dir = vec2(v.flow.x, v.flow.y).mul(FLOW_PERIOD)
    const slope = (q: V2) => {
      const h0 = h(q)
      return vec2(h0.sub(h(q.add(vec2(EPS, 0)))), h0.sub(h(q.add(vec2(0, EPS)))))
    }
    const g = mix(slope(wp.xz.sub(dir.mul(phase))), slope(wp.xz.sub(dir.mul(fract(phase.add(0.5))))), abs(phase.mul(2).sub(1)))
    const ripple = normalize(vec3(g.x.mul(RIPPLE / EPS), 1, g.y.mul(RIPPLE / EPS)))
    const n = select(isTop, ripple, v.normal)

    const thickness = depthEffects
      ? positionView.z.sub(perspectiveDepthToViewZ(viewportDepthTexture(), cameraNear, cameraFar)).max(0)
      : float(2)
    const depthT = float(1).sub(thickness.div(u.depthScale).negate().exp())
    // Two noise samples scrolling in different directions make the broken shore edge drift.
    const drift = time.mul(0.35)
    const foamNoise = mx_noise_float(vec3(wp.xz.mul(1.6).add(vec2(drift, drift.mul(0.5))), time.mul(0.3)))
      .add(mx_noise_float(vec3(wp.xz.mul(3.1).sub(vec2(drift.mul(0.6), drift.mul(1.2))), time.mul(0.45))))
      .mul(0.25).add(0.5)
    // foamWidth 0 means "foam off": the widths are floored to stay finite, and step() zeroes the result.
    const fw = max(u.foamWidth, 1e-3)
    const band = float(1).sub(smoothstep(0, max(u.foamWidth.mul(foamNoise.mul(0.8).add(0.6)), 1e-3), thickness))
    // Lapping lines: phase = thickness/w + t*0.35 is constant where thickness falls over time, so they travel shoreward.
    const lap = smoothstep(0.75, 1.0, fract(thickness.div(fw.mul(1.6)).add(time.mul(0.35)).add(foamNoise.mul(0.3))))
      .mul(float(1).sub(smoothstep(0, fw.mul(3), thickness)))
    // A thin film has a low surface height (WV4's `surface` varying): it gets almost no foam, deep water keeps its shore foam.
    const foam = depthEffects ? max(band, lap.mul(0.7)).mul(step(1e-4, u.foamWidth)).mul(smoothstep(0.2, 0.6, v.surface)) : float(0)
    const fall = float(1).add(v.flow.z.mul(2))
    const streak = select(isTop, float(0), mx_noise_float(vec3(wp.x.add(wp.z).mul(0.9), wp.y.mul(0.6).add(speed.mul(3).mul(fall)), 0)).mul(0.12))
    const albedo = mix(mix(u.shallow, u.deep, depthT).add(streak), vec3(1), foam)
    m.colorNode = vec4(albedo, mix(mix(float(0.66), float(0.94), depthT), float(1), foam))
    voxelLit(m, { normal: n, sky: v.sky, blk: v.blk, ao: float(1), albedo }, lights)

    const view = cameraPosition.sub(wp).normalize()
    const half = normalize(view.add(u.sunDir))
    const spec = dot(n, half).max(0).pow(160).mul(2.5).mul(smoothstep(0.35, 0.95, v.sky)).mul(u.sunVis)
    const fresnel = float(1).sub(dot(n, view).max(0)).pow(4).mul(0.35)
    m.emissiveNode = (m.emissiveNode as N).add(u.sunColor.mul(spec)).add(u.horizon.mul(fresnel))
    this.material = m
  }

  setParams(p: WaterParams): void {
    setLinear(this.u.shallow.value, p.shallow)
    setLinear(this.u.deep.value, p.deep)
    this.u.depthScale.value = p.depthScale
    this.u.foamWidth.value = p.foamWidth
    this.u.waveScale.value = p.waveScale
    this.u.waveSpeed.value = p.waveSpeed
  }

  applyAtmosphere(a: Atmosphere): void {
    const [x, y, z] = sunDirection(a.sun.azimuth, a.sun.elevation)
    this.u.sunDir.value.set(x, y, z)
    setLinear(this.u.sunColor.value, a.sun.color)
    this.u.sunVis.value = sunVisibility(a.sun.elevation) * Math.min(a.sun.intensity, 1)
    setLinear(this.u.horizon.value, a.sky.horizon)
  }

  dispose(): void { this.material.dispose() }
}
