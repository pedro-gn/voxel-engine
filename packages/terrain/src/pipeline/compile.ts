import { packVoxel } from '@elovox/engine/src/world/voxel.ts'
import { compileBiome, compileBiomeRule, type CompiledBiome } from '../biomes/biomes.ts'
import type { TerrainDoc } from '../doc/types.ts'
import { compileLayers, type BiomeLayer, type DensityLayer, type HeightLayer } from '../layers/layers.ts'
import { makeNoise2, type Sampler2 } from '../noise/def.ts'
import { builtinOps } from '../ops/builtin.ts'
import type { CompileContext, HeightOp, OpRegistry, VolumeOp } from '../ops/registry.ts'

/** Voxel value of placed water: full level (state 7), like the sandbox diorama. */
export const WATER_STATE = 7

export interface TerrainBlocks { fill: number; water: number; log: number; leaves: number; pineLeaves: number; rock: number }

export interface CompiledTerrain {
  readonly doc: TerrainDoc
  readonly seed: number
  /** World height (y size). */
  readonly height: number
  readonly sizeX: number
  readonly sizeZ: number
  readonly seaLevel: number
  /** Base ground height before ops. */
  readonly base: Sampler2
  readonly heightOps: readonly HeightOp[]
  readonly volumeOps: readonly VolumeOp[]
  readonly biomes: readonly CompiledBiome[]
  readonly biomeRule: (x: number, z: number, h: number) => number
  readonly heightLayer: HeightLayer
  readonly biomeLayer: BiomeLayer
  readonly densityLayer: DensityLayer
  /** Voxel values (water already carries its level state). */
  readonly blocks: TerrainBlocks
}

export interface CompileOptions {
  seed: number
  height: number
  /** Block name → block id. Throws for unknown names (the engine registry does). */
  id(name: string): number
  ops?: OpRegistry
}

/** An op threw while compiling or running. The message names the op so a document author can find it. */
export class TerrainOpError extends Error {
  readonly opId: string
  constructor(opId: string, where: string, cause: unknown) {
    super(`op "${opId}" failed ${where}: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'TerrainOpError'
    this.opId = opId
  }
}

export function compileTerrain(doc: TerrainDoc, o: CompileOptions): CompiledTerrain {
  const registry = o.ops ?? builtinOps
  const id = (name: string): number => {
    try {
      return o.id(name)
    } catch {
      throw new Error(`the terrain document uses block "${name}", which is not registered`)
    }
  }
  const biomeNames = doc.biomes.map((b) => b.name)
  const biomeIndex = (name: string) => {
    const i = biomeNames.indexOf(name)
    if (i < 0) throw new Error(`unknown biome "${name}"`)
    return i
  }
  const ctx: CompileContext = { seed: o.seed, height: o.height, seaLevel: doc.seaLevel, biomeIndex }
  const heightOps: HeightOp[] = []
  const volumeOps: VolumeOp[] = []
  for (const def of doc.ops) {
    if (!def.enabled) continue
    const impl = registry.get(def.type)
    if (!impl) throw new TerrainOpError(def.id, 'to compile', new Error(`unknown op type "${def.type}"`))
    try {
      if (impl.kind === 'height') heightOps.push(impl.compile(def, ctx))
      else volumeOps.push(impl.compile(def, ctx))
    } catch (e) {
      throw new TerrainOpError(def.id, 'to compile', e)
    }
  }
  const baseNoise = makeNoise2(doc.base.noise, o.seed)
  const { height: baseHeight, amplitude } = doc.base
  return {
    doc, seed: o.seed, height: o.height, sizeX: doc.size[0], sizeZ: doc.size[1], seaLevel: doc.seaLevel,
    base: (x, z) => baseHeight + amplitude * baseNoise(x, z),
    heightOps, volumeOps,
    biomes: doc.biomes.map((b) => compileBiome(b, id)),
    biomeRule: compileBiomeRule(doc.biomeRule, biomeIndex, o.seed),
    ...compileLayers(doc.layers),
    blocks: {
      fill: id(doc.blocks.fill), water: packVoxel(id(doc.blocks.water), WATER_STATE),
      log: id(doc.blocks.log), leaves: id(doc.blocks.leaves), pineLeaves: id(doc.blocks.pineLeaves), rock: id(doc.blocks.rock),
    },
  }
}
