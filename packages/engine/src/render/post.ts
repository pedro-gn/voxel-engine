import * as THREE from 'three/webgpu'
import { dot, mix, pass, smoothstep, uniform, vec3, vec4 } from 'three/tsl'
import type { Atmosphere } from './atmosphere.ts'
import { setLinear } from './lighting.ts'

/** Tone mapping operator: Neutral was chosen at Checkpoint 1 because AgX muted the greens. */
export const TONE_MAPPING = THREE.NeutralToneMapping

/** Scene pass (with MSAA) → colour grading; the pipeline output then applies the renderer's tone mapping. */
export class PostPipeline {
  private readonly renderer: THREE.WebGPURenderer
  private readonly scene: THREE.Scene
  private readonly camera: THREE.Camera
  private samples: number
  private pipeline: THREE.RenderPipeline
  /** RenderPipeline.dispose() only frees its quad material, so the pass's (multisampled) render target is freed here. */
  private scenePass: ReturnType<typeof pass>
  private readonly u = {
    exposure: uniform(1),
    saturation: uniform(1),
    contrast: uniform(1),
    highlights: uniform(new THREE.Color(1, 1, 1)),
    shadows: uniform(new THREE.Color(1, 1, 1)),
  }

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera, samples: number) {
    this.renderer = renderer
    this.scene = scene
    this.camera = camera
    this.samples = samples
    this.scenePass = pass(scene, camera, { samples })
    this.pipeline = this.build()
  }

  apply(a: Atmosphere): void {
    this.u.exposure.value = a.grade.exposure
    this.u.saturation.value = a.grade.saturation
    this.u.contrast.value = a.grade.contrast
    setLinear(this.u.highlights.value, a.grade.highlights)
    setLinear(this.u.shadows.value, a.grade.shadows)
  }

  setSamples(n: number): void {
    if (n === this.samples) return
    this.samples = n
    this.pipeline.dispose()
    this.scenePass.dispose()
    this.scenePass = pass(this.scene, this.camera, { samples: n })
    this.pipeline = this.build()
  }

  render(): void { this.pipeline.render() }

  dispose(): void {
    this.pipeline.dispose()
    this.scenePass.dispose()
  }

  private build(): THREE.RenderPipeline {
    const p = new THREE.RenderPipeline(this.renderer)
    const u = this.u
    const c = this.scenePass.rgb.mul(u.exposure)
    const luma = dot(c, vec3(0.2126, 0.7152, 0.0722))
    const sat = mix(vec3(luma), c, u.saturation)
    const con = sat.sub(0.18).mul(u.contrast).add(0.18).max(0)
    const tint = mix(u.shadows, u.highlights, smoothstep(0.05, 0.8, luma))
    p.outputNode = vec4(con.mul(tint), 1)
    return p
  }
}
