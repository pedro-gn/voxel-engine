import * as THREE from 'three/webgpu'
import {
  cameraPosition, dot, float, fog, mix, mx_fractal_noise_float, normalWorldGeometry, positionView, positionWorld,
  screenUV, smoothstep, time, uniform, vec2, vec3,
} from 'three/tsl'
import { sunDirection, type Atmosphere } from './atmosphere.ts'
import { setLinear } from './lighting.ts'

const CLOUD_ALTITUDE = 300

/** Sky dome / flat backdrop (scene.backgroundNode) and atmospheric fog (scene.fogNode), both driven by the atmosphere. */
export class Sky {
  private readonly u = {
    zenith: uniform(new THREE.Color()),
    horizon: uniform(new THREE.Color()),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
    sunColor: uniform(new THREE.Color()),
    sunGlow: uniform(0),
    dome: uniform(1),
    coverage: uniform(0.4),
    cloudScale: uniform(400),
    cloudSpeed: uniform(4),
    cloudLight: uniform(new THREE.Color()),
    cloudShade: uniform(new THREE.Color()),
    fogColor: uniform(new THREE.Color()),
    fogFollow: uniform(1),
    fogNear: uniform(100),
    fogFar: uniform(800),
    fogHeight: uniform(0.01),
  }
  readonly backgroundNode
  readonly fogNode

  constructor() {
    const u = this.u
    const dir = normalWorldGeometry.normalize()
    const gradient = mix(u.horizon, u.zenith, dir.y.max(0).pow(0.55))
    const sd = dot(dir, u.sunDir).max(0)
    const glow = u.sunColor.mul(sd.pow(48).mul(u.sunGlow).add(smoothstep(0.9995, 0.9999, sd).mul(3)))
    const t = float(CLOUD_ALTITUDE).sub(cameraPosition.y).div(dir.y.max(0.03))
    const p = cameraPosition.xz.add(dir.xz.mul(t)).add(vec2(time.mul(u.cloudSpeed), 0)).div(u.cloudScale)
    const n = mx_fractal_noise_float(vec3(p, 0), 4, 2, 0.5).mul(0.5).add(0.5)
    const n2 = mx_fractal_noise_float(vec3(p.add(u.sunDir.xz.mul(0.06)), 0), 4, 2, 0.5).mul(0.5).add(0.5)
    const edge = float(1).sub(u.coverage)
    const density = smoothstep(edge, edge.add(0.12), n).mul(smoothstep(0.03, 0.2, dir.y))
    const cloud = mix(u.cloudShade, u.cloudLight, smoothstep(-0.02, 0.06, n.sub(n2)))
    const dome = mix(gradient.add(glow), cloud, density)
    // Spike P7 (confirmed on WebGPU and WebGL): screenUV.y is 1 at the BOTTOM of the screen, so flip it.
    const screenUp = screenUV.y.oneMinus()
    const flat = mix(u.horizon, u.zenith, screenUp)
    this.backgroundNode = mix(flat, dome, u.dome)

    const dist = positionView.length()
    const d = dist.sub(u.fogNear).div(u.fogFar.sub(u.fogNear)).max(0)
    const factor = float(1).sub(d.mul(d).mul(-4).exp()).mul(positionWorld.y.mul(u.fogHeight).negate().exp()).clamp(0, 1)
    const view = positionWorld.sub(cameraPosition).normalize()
    const base = mix(u.fogColor, u.horizon, u.fogFollow)
    const warm = mix(base, base.mul(u.sunColor).mul(1.4), dot(view, u.sunDir).max(0).pow(6).mul(0.5))
    this.fogNode = fog(warm, factor)
  }

  apply(a: Atmosphere): void {
    const u = this.u
    setLinear(u.zenith.value, a.sky.zenith)
    setLinear(u.horizon.value, a.sky.horizon)
    const [x, y, z] = sunDirection(a.sun.azimuth, a.sun.elevation)
    u.sunDir.value.set(x, y, z)
    setLinear(u.sunColor.value, a.sun.color)
    u.sunGlow.value = a.sky.sunGlow
    u.dome.value = a.sky.dome
    u.coverage.value = a.sky.clouds.coverage
    u.cloudScale.value = a.sky.clouds.scale
    u.cloudSpeed.value = a.sky.clouds.speed
    setLinear(u.cloudLight.value, a.sky.clouds.light)
    setLinear(u.cloudShade.value, a.sky.clouds.shade)
    setLinear(u.fogColor.value, a.fog.color)
    u.fogFollow.value = a.fog.followHorizon
    u.fogNear.value = a.fog.near
    u.fogFar.value = a.fog.far
    u.fogHeight.value = a.fog.heightFalloff
  }

  attach(scene: THREE.Scene, fogOn: boolean): void {
    scene.background = null
    scene.backgroundNode = this.backgroundNode
    scene.fogNode = fogOn ? this.fogNode : null
  }

  detach(scene: THREE.Scene): void {
    scene.backgroundNode = null
    scene.fogNode = null
  }
}
