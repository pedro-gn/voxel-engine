export { createTerrainGenerator, terrainGenerator, type TerrainGeneratorOptions } from './generator.ts'
export { TERRAIN_FORMAT, TERRAIN_VERSION, TerrainDocError, validateTerrainDoc, type ValidateOptions, type ValidateResult } from './doc/validate.ts'
export type {
  BaseDef, BiomeDef, BiomeRule, BiomeRuleEntry, BlendMode, BlockNames, BrickRef, BrickSetRef, OpDef, PathPoint,
  RasterRef, ShapeDef, ShapeKind, SurfaceRule, TerrainDoc, TerrainLayers, TreeKind, Vec2,
} from './doc/types.ts'
export { BLEND_MODES } from './doc/types.ts'
export { NOISE_TYPES } from './noise/def.ts'
export { FEATURE_REACH } from './features/place.ts'
export type { Rect } from './geom.ts'
export { Check, checkNoise } from './doc/check.ts'
export { BUILTIN_OPS, builtinOps } from './ops/builtin.ts'
export {
  OpRegistry, defineTerrainOp,
  type Cell, type CompileContext, type HeightOp, type HeightOpImpl, type HeightOpSpec, type OpImpl, type ValidateContext,
  type VolumeOp, type VolumeOpImpl, type VolumeOpSpec,
} from './ops/registry.ts'
export {
  BELOW_TOP, WORLD_TOP, checkParams, paramsOf, resolveBound,
  type BiomeParam, type BoolParam, type Bound, type EnumParam, type NoiseParam, type NumberParam, type ParamSchema, type ParamSpec, type ParamValues,
} from './ops/schema.ts'
export { compileShape, newSample, weight, type Shape, type ShapeSample } from './shapes/shape.ts'
export { PROFILES, profile, smoothstep01, type Profile } from './shapes/profile.ts'
export { blend } from './shapes/blend.ts'
export { encodeBrick, encodeRaster, decodeRaster } from './layers/raster.ts'
export { makeNoise2, makeNoise3, type NoiseDef, type NoiseType, type Sampler2, type Sampler3 } from './noise/def.ts'
export { compileTerrain, TerrainOpError, type CompiledTerrain } from './pipeline/compile.ts'
export { generateRegion } from './pipeline/region.ts'
export { hash2, hash3, unit } from './noise/hash.ts'
