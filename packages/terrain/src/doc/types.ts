import type { NoiseDef } from '../noise/def.ts'

export type Vec2 = [number, number]

/** A path vertex. `y` is used by volume ops; `width` overrides the path's width at this vertex. */
export interface PathPoint { x: number; z: number; y?: number; width?: number }

/**
 * Where an op acts. `falloff` (blocks, default 0) widens the op's mask past the shape's edge with a
 * smooth fade. `inset` (polygons, default 16) is how far inside the edge the profile reaches full strength.
 */
export type ShapeDef =
  | { kind: 'circle'; center: Vec2; radius: number; falloff?: number }
  | { kind: 'polygon'; points: Vec2[]; inset?: number; falloff?: number }
  | { kind: 'path'; points: PathPoint[]; width: number; falloff?: number }

export type ShapeKind = ShapeDef['kind']

/** How a height op combines with the height so far. add/carve take relative values; max/min/set take absolute y. */
export type BlendMode = 'add' | 'carve' | 'max' | 'min' | 'set'
export const BLEND_MODES: readonly BlendMode[] = ['add', 'carve', 'max', 'min', 'set']

export interface OpDef {
  /** Stable and unique within the document; the editor selects ops by id. */
  id: string
  type: string
  enabled: boolean
  shape: ShapeDef
  params: Record<string, unknown>
  /** Height ops only; each op type has a default. */
  blend?: BlendMode
}

/** The procedural fill under every op: `height + amplitude * noise(x, z)`, noise in [0, 1]. */
export interface BaseDef { height: number; amplitude: number; noise: NoiseDef }

/** One surface rule. A voxel takes the block of the first rule of its biome that matches. */
export interface SurfaceRule {
  /** Required unless `bands` is given. */
  block?: string
  /** Solid voxels between this one and the nearest air or water above it. Default [0, 0]. */
  depth?: Vec2
  /** Rise per block, from the height field. Default: any. */
  slope?: Vec2
  /** Absolute y. Default: any. */
  y?: Vec2
  /** true: only under water; false: only under air. Default: either. */
  underwater?: boolean
  /** Matches only within this many blocks above the column's water reference. Default: any. */
  nearWater?: number
  /** true: only voxels with air right below (cave roofs, overhangs). false: never those. Default: either. */
  ceiling?: boolean
  /** Instead of `block`, pick blocks[floor(y / thickness) % blocks.length]: horizontal strata. */
  bands?: { blocks: string[]; thickness: number }
}

export type TreeKind = 'broadleaf' | 'pine' | 'bush'
export const TREE_KINDS: readonly TreeKind[] = ['broadleaf', 'pine', 'bush']

export interface BiomeDef {
  name: string
  surface: SurfaceRule[]
  /** density: chance per 8 × 8 feature cell. on: surface blocks a tree may stand on (default ['grass']). */
  trees?: { density: number; kinds: TreeKind[]; on?: string[] }
  /** density: chance per feature cell (after trees). size: radius range in blocks, at most 6. */
  rocks?: { density: number; size: Vec2 }
}

export interface BiomeRuleEntry { biome: string; minHeight?: number; maxHeight?: number; moisture?: Vec2 }

/** The biome of a column when no biome op or biome layer sets one: first matching rule, else `default`. */
export interface BiomeRule {
  default: string
  /** Moisture noise read by entries with a `moisture` range. Default { scale: 300 }. */
  moisture?: NoiseDef
  rules?: BiomeRuleEntry[]
}

/** Block names the pipeline places by itself. */
export interface BlockNames { fill: string; water: string; log: string; leaves: string; pineLeaves: string; rock: string }
export const DEFAULT_BLOCKS: BlockNames = { fill: 'stone', water: 'water', log: 'log', leaves: 'leaves', pineLeaves: 'pine_leaves', rock: 'rock' }

/** A tile of a 2D layer in the file. x and z count tiles; data holds the values as little-endian base64. */
export interface TileRef { x: number; z: number; data: string }
/** An 8³ brick of density samples in the file. x, y and z count bricks. */
export interface BrickRef { x: number; y: number; z: number; data: string }

/** The layers as a .terrain.json file stores them: only painted tiles. */
export interface TerrainLayersJSON {
  height?: { tiles: TileRef[] }
  biome?: { tiles: TileRef[] }
  density?: { bricks: BrickRef[] }
}

/** 64 × 64 columns of height delta in 1/16 block; index lx + lz * 64. */
export interface HeightTile { x: number; z: number; values: Int16Array }
/** 16 × 16 biome cells of 4 × 4 columns (0 = unpainted, k = biomes[k - 1]); index cx + cz * 16. */
export interface BiomeTile { x: number; z: number; values: Uint8Array }
/** 8³ density samples 2 blocks apart, in 1/8 block; index lx + lz * 8 + ly * 64. */
export interface DensityBrick { x: number; y: number; z: number; values: Int8Array }

/**
 * The decoded brush layers. Lists are sorted (tiles by z then x; bricks by y, z, x), hold no all-zero
 * tile, and are absent when empty. A tile is never mutated once it is in a document: edits replace
 * it, so documents share the tiles they have in common.
 */
export interface TerrainLayers {
  /** Added to the height after every height op. */
  height?: { tiles: HeightTile[] }
  /** Overrides the biome rule and biome ops. */
  biome?: { tiles: BiomeTile[] }
  /** Added to the density after every volume op. */
  density?: { bricks: DensityBrick[] }
}

/** A validated, normalized terrain document (every default filled in). */
export interface TerrainDoc {
  format: 'elovox-terrain'
  version: 1
  /** World x and z. Must equal the engine world's. */
  size: Vec2
  /** Every non-solid voxel below this y is water, in every column. Keep inland ground above it. */
  seaLevel: number
  blocks: BlockNames
  base: BaseDef
  biomes: BiomeDef[]
  biomeRule: BiomeRule
  ops: OpDef[]
  layers: TerrainLayers
}
