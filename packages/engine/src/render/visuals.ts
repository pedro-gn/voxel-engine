import * as THREE from 'three/webgpu'
import type { ChunkMeshData } from '../mesh/mesher.ts'
import type { Layout } from '../world/layout.ts'
import type { BlockRegistry } from '../blocks/registry.ts'
import { FragmentMeshes } from './fragments.ts'
import type { FragmentFrame } from './fragmentTrack.ts'
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
import { cameraFar, shadowReach } from './viewDistance.ts'
import { Sky } from './sky.ts'
import { createLightUniforms, type LightUniforms } from './voxelLighting.ts'
import { WaterMaterial } from './water.ts'
import type { SurfaceView } from './water/surfaceView.ts'
import { WaterSurface } from './water/waterSurface.ts'
import { editRipples, ripples, syncRipples, type EditCommand } from './water/ripples.ts'
import { waterAlpha } from './water/waterVertex.ts'

export interface VisualsOptions {
  renderer: THREE.WebGPURenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  backend: Backend
  texture: THREE.DataArrayTexture
  /** Per texture-array layer: blocks spanned by one texture repeat (engine `textureScale` option). */
  textureScales?: Float32Array
  layout: Layout
  registry: BlockRegistry
  /** The orbit camera's distance to its target; sets how far shadows reach. */
  viewDistance: () => number
  decorations: DecorationRegistry
  /** Per block id × 6 faces (+X −X +Y −Y +Z −Z): texture-array layer (BlockRegistry.faceLayers). */
  faceLayers: Uint16Array
  /** The main thread's view of the heightfield water (engine.ts feeds it from the tick messages). */
  water: SurfaceView
  /** Draw the opaque and cutout chunk layers in region batches (EngineOptions.batchChunks). Default true. */
  batchChunks?: boolean
  /** @internal three's own batch cull, the pixel-diff reference (EngineOptions.threeCull). Default false. */
  threeCull?: boolean
}

/** Everything about how the world looks. Owns the lights and shadows, chunk materials, sky and fog, and the post pipeline (grading, tone mapping, MSAA). Also owns the stylized water materials, the heightfield water surface and the instanced grass and flower decorations. */
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
  private readonly waterSurface: WaterSurface
  private waterParams: WaterParams = DEFAULT_WATER
  private readonly deco: DecorationMeshes
  private readonly decoRadius: { value: number }
  private readonly falling: FallingCubes
  private readonly fragments: FragmentMeshes
  private decoStats = { instances: 0, draws: 0 }
  private readonly warned = new Set<string>()

  constructor(o: VisualsOptions) {
    this.o = o
    o.renderer.shadowMap.enabled = true
    o.renderer.shadowMap.type = THREE.PCFShadowMap
    this.lights = createLightUniforms()
    this.chunks = new ChunkMeshes(o.layout, createChunkMaterials(o.texture, this.lights, o.textureScales), { batched: o.batchChunks ?? true, threeCull: o.threeCull ?? false })
    o.scene.add(this.chunks.group)
    const dm = createDecorationMaterials(o.decorations, this.lights)
    this.decoRadius = dm.radius
    this.deco = new DecorationMeshes(o.layout, dm)
    o.scene.add(this.deco.group)
    this.falling = new FallingCubes(o.texture, this.lights, o.faceLayers)
    o.scene.add(this.falling.mesh)
    this.fragments = new FragmentMeshes(o.layout, o.registry, o.faceLayers, o.texture, this.lights)
    o.scene.add(this.fragments.group)
    this.sun = new SunLights(o.scene, this.quality.shadowMapSize)
    this.effects = this.resolve(this.requested)
    this.water = new WaterMaterial(this.lights, resolveEffects(this.requested, SUPPORT[o.backend]).waterDepth)
    this.water.setParams(this.waterParams)
    this.waterSurface = new WaterSurface(o.layout.size[1], o.water, this.water.surface, this.water.curtain)
    o.scene.add(this.waterSurface.group)
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
  drawFragments(frames: readonly FragmentFrame[], light: (x: number, y: number, z: number) => number): void { this.fragments.set(frames, light) }

  /** How far the water surface is between the previous and the current water step (0–1). */
  setWaterAlpha(a: number): void { waterAlpha.value = a }

  /** An edit was submitted: starts the ripples of one at a water line (see editRipples); `get` is the main thread's voxel copy. */
  noteEdit(cmd: EditCommand, get: (x: number, y: number, z: number) => number): void {
    editRipples(this.o.water, ripples, cmd, get)
  }

  frame(dt: number): void {
    // View distance (spec 4b §5): what lies beyond it is not drawn; at Infinity every step below is a no-op.
    const range = this.quality.viewDistance, eye = this.o.camera.position
    this.chunks.beginFrame(eye, range)
    this.waterSurface.setRange(eye, range)
    const cf = cameraFar(range)
    if (this.o.camera.far !== cf) { this.o.camera.far = cf; this.o.camera.updateProjectionMatrix() }
    this.sky.setViewDistance(range)
    const fogNode = this.sky.fogFor(this.effects.fog, range)
    if (this.o.scene.fogNode !== fogNode) this.o.scene.fogNode = fogNode
    ripples.update(dt)
    syncRipples()
    if (this.atmosphere.update(dt)) this.applyAtmosphere(this.atmosphere.current)
    const far = shadowReach(this.o.viewDistance(), range)
    this.lights.shadowFar.value = far
    if (this.effects.shadows) this.sun.fit(this.o.camera, far, 0, this.o.layout.size[1], this.quality.shadowMapSize)
    const decoRadius = Math.min(this.quality.decorationRadius, range)
    this.deco.group.visible = this.effects.decorations
    this.decoRadius.value = decoRadius
    this.decoStats = this.effects.decorations
      ? this.deco.cull(eye, decoRadius, this.quality.decorationMaxInstances)
      : { instances: 0, draws: 0 }
    this.waterSurface.update()
    if (this.effects.post) this.post.render()
    else this.o.renderer.render(this.o.scene, this.o.camera)
  }

  stats(): { shadowCasters: number; decorationInstances: number; decorationDraws: number; chunksDrawn: number } {
    return {
      shadowCasters: this.effects.shadows ? this.chunks.shadowCasterCount : 0,
      decorationInstances: this.decoStats.instances,
      decorationDraws: this.decoStats.draws,
      chunksDrawn: this.chunks.drawnCount,
    }
  }

  dispose(): void {
    this.o.scene.remove(this.chunks.group)
    this.chunks.dispose()
    this.o.scene.remove(this.deco.group)
    this.deco.dispose()
    this.o.scene.remove(this.falling.mesh)
    this.falling.dispose()
    this.o.scene.remove(this.fragments.group); this.fragments.dispose()
    this.o.scene.remove(this.waterSurface.group)
    this.waterSurface.dispose()
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
    const on = this.effects.water
    this.chunks.setLayerMaterial('liquid', on ? this.water.voxel : this.chunks.baseMaterial('liquid'))
    this.waterSurface.setMaterials(on ? this.water.surface : this.water.plainSurface, on ? this.water.curtain : this.water.plainCurtain)
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
