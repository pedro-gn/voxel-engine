import * as THREE from 'three/webgpu'
import { sunDirection, sunVisibility, type Atmosphere, type Rgb } from './atmosphere.ts'
import { fitShadow, frustumCorners, type V3 } from './shadowFit.ts'

/** three's lookAt degenerates for a vertical light direction. */
const MAX_ELEVATION = 89.5
const forward = new THREE.Vector3()

export function setLinear(c: THREE.Color, rgb: Rgb): THREE.Color {
  return c.setRGB(rgb[0], rgb[1], rgb[2], THREE.LinearSRGBColorSpace)
}

/** The sun (DirectionalLight with one view-fitted shadow map) and the hemisphere ambient, driven by the atmosphere. */
export class SunLights {
  readonly sun = new THREE.DirectionalLight()
  readonly hemi = new THREE.HemisphereLight()
  private readonly scene: THREE.Scene
  private dir: V3 = [0, 1, 0]
  private visible = 1
  private enabled = true

  constructor(scene: THREE.Scene, mapSize: number) {
    this.scene = scene
    const s = this.sun.shadow
    s.mapSize.set(mapSize, mapSize)
    s.radius = 2.5 // soft PCF (Task 1, P5)
    s.bias = -0.0004 // the bias confirmed by the Task 1 spike
    s.normalBias = 0 // the materials offset along their own normal instead (voxelLighting.ts)
    scene.add(this.sun, this.sun.target, this.hemi)
  }

  apply(a: Atmosphere): void {
    this.dir = sunDirection(a.sun.azimuth, Math.min(MAX_ELEVATION, a.sun.elevation))
    this.visible = sunVisibility(a.sun.elevation)
    setLinear(this.sun.color, a.sun.color)
    this.sun.intensity = a.sun.intensity * this.visible * Math.PI
    setLinear(this.hemi.color, a.ambient.sky)
    setLinear(this.hemi.groundColor, a.ambient.ground)
    this.hemi.intensity = a.ambient.intensity * Math.PI
    this.sun.castShadow = this.enabled && this.visible > 0
  }

  /** Refits the shadow camera to the view (call every frame shadows are on). */
  fit(camera: THREE.PerspectiveCamera, far: number, minY: number, maxY: number, mapSize: number): void {
    camera.getWorldDirection(forward)
    const p = camera.position
    const corners = frustumCorners([p.x, p.y, p.z], [forward.x, forward.y, forward.z], [0, 1, 0], camera.fov, camera.aspect, camera.near, Math.min(far, camera.far))
    const f = fitShadow(corners, this.dir, mapSize, minY, maxY)
    this.sun.position.set(f.position[0], f.position[1], f.position[2])
    this.sun.target.position.set(f.target[0], f.target[1], f.target[2])
    this.sun.updateMatrixWorld()
    this.sun.target.updateMatrixWorld()
    const c = this.sun.shadow.camera
    c.left = -f.halfSize
    c.right = f.halfSize
    c.top = f.halfSize
    c.bottom = -f.halfSize
    c.near = Math.max(0.5, f.near)
    c.far = f.far
    c.updateProjectionMatrix()
  }

  setMapSize(n: number): void {
    const s = this.sun.shadow
    if (s.mapSize.x === n) return
    s.mapSize.set(n, n)
    s.map?.dispose()
    s.map = null
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    this.sun.castShadow = on && this.visible > 0
  }

  dispose(): void {
    this.scene.remove(this.sun, this.sun.target, this.hemi)
    this.sun.shadow.dispose()
    this.sun.dispose()
    this.hemi.dispose()
  }
}
