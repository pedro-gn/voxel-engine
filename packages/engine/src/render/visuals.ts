import * as THREE from 'three/webgpu'
import type { ChunkMeshData } from '../mesh/mesher.ts'
import type { Layout } from '../world/layout.ts'
import { AtmosphereController, type Atmosphere } from './atmosphere.ts'
import { DecorationMeshes } from './decorations/decorationMeshes.ts'
import type { DecorationRegistry } from './decorations/defs.ts'
import { createDecorationMaterials } from './decorations/material.ts'
import { ChunkMeshes } from './chunkMeshes.ts'
import { FallingCubes } from './falling.ts'
import type { FallingCube } from './fallingTrack.ts'
import { SunLights } from './lighting.ts'
import { createChunkMaterials } from './materials.ts'
import { PostPipeline, TONE_MAPPING } from './post.ts'
import {
  DEFAULT_EFFECTS, DEFAULT_QUALITY, DEFAULT_WATER, SUPPORT, mergeEffects, mergeQuality, mergeWater, resolveEffects,
  type Backend, type Effects, type Quality, type WaterInput, type WaterParams,
} from './settings.ts'
import { shadowDistance } from './shadowFit.ts'
import { Sky } from './sky.ts'
import { createLightUniforms, type LightUniforms } from './voxelLighting.ts'
import { WaterMaterial } from './water.ts'

export interface VisualsOptions {
  renderer: THREE.WebGPURenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  backend: Backend
  texture: THREE.DataArrayTexture
  /** Per texture-array layer: blocks spanned by one texture repeat (engine `textureScale` option). */
  textureScales?: Float32Array
  layout: Layout
  /** The orbit camera's distance to its target; sets how far shadows reach. */
  viewDistance: () => number
  decorations: DecorationRegistry
  /** Per block id × 6 faces (+X −X +Y −Y +Z −Z): texture-array layer (BlockRegistry.faceLayers). */
  faceLayers: Uint16Array
}

/** Everything about how the world looks. Owns the lights and shadows, chunk materials, sky and fog, and the post pipeline (grading, tone mapping, MSAA). Also owns the stylized water material and the instanced grass and flower decorations. */
export class Visuals {
  readonly atmosphere = new AtmosphereController()
  readonly chunks: ChunkMeshes
  private readonly o: VisualsOptions
  private readonly lights: LightUniforms
  private readonly sun: SunLights
  private readonly sky = new Sky()
  private readonly post: PostPipeline
  private quality: Quality = DEFAULT_QUALITY
  private requested: Effects = DEFAULT_EFFECTS
  private effects: Effects
  private readonly water: WaterMaterial
  private waterParams: WaterParams = DEFAULT_WATER
  private readonly deco: DecorationMeshes
  private readonly decoRadius: { value: number }
  private readonly falling: FallingCubes
  private decoStats = { instances: 0, draws: 0 }
  private readonly warned = new Set<string>()

  constructor(o: VisualsOptions) {
    this.o = o
    o.renderer.shadowMap.enabled = true
    o.renderer.shadowMap.type = THREE.PCFShadowMap
    this.lights = createLightUniforms()
    this.chunks = new ChunkMeshes(o.layout, createChunkMaterials(o.texture, this.lights, o.textureScales))
    o.scene.add(this.chunks.group)
    const dm = createDecorationMaterials(o.decorations, this.lights)
    this.decoRadius = dm.radius
    this.deco = new DecorationMeshes(o.layout, dm)
    o.scene.add(this.deco.group)
    this.falling = new FallingCubes(o.texture, this.lights, o.faceLayers)
    o.scene.add(this.falling.mesh)
    this.sun = new SunLights(o.scene, this.quality.shadowMapSize)
    this.effects = this.resolve(this.requested)
    this.water = new WaterMaterial(this.lights, resolveEffects(this.requested, SUPPORT[o.backend]).waterDepth)
    this.water.setParams(this.waterParams)
    this.syncWater()
    o.renderer.toneMapping = TONE_MAPPING
    this.post = new PostPipeline(o.renderer, o.scene, o.camera, this.quality.msaa)
    this.sky.attach(o.scene, this.effects.fog)
  }

  getQuality(): Quality { return this.quality }
  setQuality(input: Partial<Quality>): void {
    this.quality = mergeQuality(this.quality, input)
    this.sun.setMapSize(this.quality.shadowMapSize)
    this.post.setSamples(this.quality.msaa)
  }

  getEffects(): Effects { return this.effects }
  setEffects(input: Partial<Effects>): void {
    this.requested = mergeEffects(this.requested, input)
    this.effects = this.resolve(this.requested)
    this.syncWater()
    this.sky.attach(this.o.scene, this.effects.fog)
  }

  getWater(): WaterParams { return this.waterParams }
  setWater(input: WaterInput): void {
    this.waterParams = mergeWater(this.waterParams, input)
    this.water.setParams(this.waterParams)
  }

  applyMesh(ci: number, data: ChunkMeshData): void {
    this.chunks.apply(ci, data)
    this.deco.apply(ci, data.grass, data.flowers)
  }

  /** Falling blocks to draw this frame. */
  drawFalling(cubes: readonly FallingCube[], light: (x: number, y: number, z: number) => number): void {
    this.falling.set(cubes, light)
  }

  frame(dt: number): void {
    if (this.atmosphere.update(dt)) this.applyAtmosphere(this.atmosphere.current)
    const far = shadowDistance(this.o.viewDistance())
    this.lights.shadowFar.value = far
    if (this.effects.shadows) this.sun.fit(this.o.camera, far, 0, this.o.layout.size[1], this.quality.shadowMapSize)
    this.deco.group.visible = this.effects.decorations
    this.decoRadius.value = this.quality.decorationRadius
    this.decoStats = this.effects.decorations
      ? this.deco.cull(this.o.camera.position, this.quality.decorationRadius, this.quality.decorationMaxInstances)
      : { instances: 0, draws: 0 }
    if (this.effects.post) this.post.render()
    else this.o.renderer.render(this.o.scene, this.o.camera)
  }

  stats(): { shadowCasters: number; decorationInstances: number; decorationDraws: number } {
    return {
      shadowCasters: this.effects.shadows ? this.chunks.shadowCasterCount : 0,
      decorationInstances: this.decoStats.instances,
      decorationDraws: this.decoStats.draws,
    }
  }

  dispose(): void {
    this.o.scene.remove(this.chunks.group)
    this.chunks.dispose()
    this.o.scene.remove(this.deco.group)
    this.deco.dispose()
    this.o.scene.remove(this.falling.mesh)
    this.falling.dispose()
    this.water.dispose()
    this.sun.dispose()
    this.sky.detach(this.o.scene)
    this.post.dispose()
  }

  private applyAtmosphere(a: Atmosphere): void {
    this.sun.apply(a)
    this.sky.apply(a)
    this.post.apply(a)
    this.water.applyAtmosphere(a)
    const t = a.shadow.tint, k = a.shadow.strength
    this.lights.shadowColor.value.setRGB(1 + (t[0] - 1) * k, 1 + (t[1] - 1) * k, 1 + (t[2] - 1) * k, THREE.LinearSRGBColorSpace)
  }

  private syncWater(): void {
    this.chunks.setLayerMaterial('liquid', this.effects.water ? this.water.material : this.chunks.baseMaterial('liquid'))
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
