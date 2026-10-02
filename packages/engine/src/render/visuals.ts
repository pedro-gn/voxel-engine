import * as THREE from 'three/webgpu'
import type { ChunkMeshData } from '../mesh/mesher.ts'
import type { Layout } from '../world/layout.ts'
import { AtmosphereController, type Atmosphere } from './atmosphere.ts'
import { ChunkMeshes } from './chunkMeshes.ts'
import { SunLights } from './lighting.ts'
import { createChunkMaterials } from './materials.ts'
import {
  DEFAULT_EFFECTS, DEFAULT_QUALITY, SUPPORT, mergeEffects, mergeQuality, resolveEffects,
  type Backend, type Effects, type Quality,
} from './settings.ts'
import { shadowDistance } from './shadowFit.ts'
import { Sky } from './sky.ts'
import { createLightUniforms, type LightUniforms } from './voxelLighting.ts'

export interface VisualsOptions {
  renderer: THREE.WebGPURenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  backend: Backend
  texture: THREE.DataArrayTexture
  layout: Layout
  /** The orbit camera's distance to its target; sets how far shadows reach. */
  viewDistance: () => number
}

/** Everything about how the world looks: lights, shadows, materials, and (in later tasks) sky, post, water, decorations. */
export class Visuals {
  readonly atmosphere = new AtmosphereController()
  readonly chunks: ChunkMeshes
  private readonly o: VisualsOptions
  private readonly lights: LightUniforms
  private readonly sun: SunLights
  private readonly sky = new Sky()
  private quality: Quality = DEFAULT_QUALITY
  private requested: Effects = DEFAULT_EFFECTS
  private effects: Effects
  private readonly warned = new Set<string>()

  constructor(o: VisualsOptions) {
    this.o = o
    o.renderer.shadowMap.enabled = true
    o.renderer.shadowMap.type = THREE.PCFShadowMap
    this.lights = createLightUniforms()
    this.chunks = new ChunkMeshes(o.layout, createChunkMaterials(o.texture, this.lights))
    o.scene.add(this.chunks.group)
    this.sun = new SunLights(o.scene, this.quality.shadowMapSize)
    this.effects = this.resolve(this.requested)
    this.sky.attach(o.scene, this.effects.fog)
  }

  getQuality(): Quality { return this.quality }
  setQuality(input: Partial<Quality>): void {
    this.quality = mergeQuality(this.quality, input)
    this.sun.setMapSize(this.quality.shadowMapSize)
  }

  getEffects(): Effects { return this.effects }
  setEffects(input: Partial<Effects>): void {
    this.requested = mergeEffects(this.requested, input)
    this.effects = this.resolve(this.requested)
    this.sky.attach(this.o.scene, this.effects.fog)
  }

  applyMesh(ci: number, data: ChunkMeshData): void {
    this.chunks.apply(ci, data)
  }

  frame(dt: number): void {
    if (this.atmosphere.update(dt)) this.applyAtmosphere(this.atmosphere.current)
    const far = shadowDistance(this.o.viewDistance())
    this.lights.shadowFar.value = far
    if (this.effects.shadows) this.sun.fit(this.o.camera, far, 0, this.o.layout.size[1], this.quality.shadowMapSize)
    this.o.renderer.render(this.o.scene, this.o.camera)
  }

  stats(): { shadowCasters: number } {
    return { shadowCasters: this.effects.shadows ? this.chunks.shadowCasterCount : 0 }
  }

  dispose(): void {
    this.o.scene.remove(this.chunks.group)
    this.chunks.dispose()
    this.sun.dispose()
    this.sky.detach(this.o.scene)
  }

  private applyAtmosphere(a: Atmosphere): void {
    this.sun.apply(a)
    this.sky.apply(a)
    const t = a.shadow.tint, k = a.shadow.strength
    this.lights.shadowColor.value.setRGB(1 + (t[0] - 1) * k, 1 + (t[1] - 1) * k, 1 + (t[2] - 1) * k, THREE.LinearSRGBColorSpace)
  }

  private resolve(requested: Effects): Effects {
    const r = resolveEffects(requested, SUPPORT[this.o.backend])
    for (const w of r.warnings) {
      if (this.warned.has(w)) continue
      this.warned.add(w)
      console.warn(`[elovox] ${w}`)
    }
    this.sun.setEnabled(r.effects.shadows)
    return r.effects
  }
}
