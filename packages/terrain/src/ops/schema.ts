import { Check, checkNoise } from '../doc/check.ts'
import type { OpDef } from '../doc/types.ts'
import type { NoiseDef } from '../noise/def.ts'
import type { ValidateContext } from './registry.ts'

/** A numeric bound, fixed or relative to the world (schemas are code, so a function is fine). */
export type Bound = number | ((ctx: ValidateContext) => number)

/** The world height: an absolute y may reach it. */
export const WORLD_TOP: Bound = (ctx) => ctx.height
/** One below the world height: the highest water or river level. */
export const BELOW_TOP: Bound = (ctx) => ctx.height - 1

export interface NumberParam {
  type: 'number'
  /** A missing value is an error. Otherwise a missing value reads as `default`. */
  required?: boolean
  /** The value of a missing optional param, and the value a new op starts with. Without it, a missing optional param reads as undefined. */
  default?: number
  min?: number
  max?: Bound
  gt?: number
  int?: boolean
  /** Inspector step. Default: 1 for int and anchored params, else 0.1. */
  step?: number
  /** Inspector slider range where min/max leave it open. */
  range?: readonly [number, number]
  /** An absolute y: a new op sets it to the ground height under the op plus `default`. Anchored params are required. */
  anchor?: 'ground'
}
export interface EnumParam { type: 'enum'; values: readonly string[]; default: string }
export interface NoiseParam { type: 'noise'; default: NoiseDef }
export interface BoolParam { type: 'bool'; default: boolean }
/** A required biome name from the document's `biomes`. */
export interface BiomeParam { type: 'biome' }
export type ParamSpec = NumberParam | EnumParam | NoiseParam | BoolParam | BiomeParam
export type ParamSchema = Readonly<Record<string, ParamSpec>>

type ValueOf<P> =
  P extends { type: 'number' } ? (P extends { default: number } ? number : P extends { required: true } ? number : number | undefined)
  : P extends { type: 'enum'; values: readonly (infer V)[] } ? V
  : P extends { type: 'noise' } ? NoiseDef
  : P extends { type: 'bool' } ? boolean
  : P extends { type: 'biome' } ? string
  : never

/** The params of an op whose schema is S, with every default filled in. */
export type ParamValues<S extends ParamSchema> = { -readonly [K in keyof S]: ValueOf<S[K]> }

export function resolveBound(b: Bound | undefined, ctx: ValidateContext): number | undefined {
  return typeof b === 'function' ? b(ctx) : b
}

/** Validates `def.params` against `schema`: unknown keys first, then every param in schema order. */
export function checkParams(c: Check, path: string, def: OpDef, schema: ParamSchema, ctx: ValidateContext): void {
  const known = Object.keys(schema)
  for (const key of Object.keys(def.params)) {
    if (Object.hasOwn(schema, key)) continue
    c.fail(`${path}.params.${key}`, known.length > 0 ? `unknown param (known: ${known.join(', ')})` : 'unknown param (this op takes none)')
  }
  for (const [key, spec] of Object.entries(schema)) {
    const p = `${path}.params.${key}`
    const v = def.params[key]
    switch (spec.type) {
      case 'number':
        c.num(p, v, { min: spec.min, max: resolveBound(spec.max, ctx), gt: spec.gt, int: spec.int, optional: !spec.required })
        break
      case 'enum': c.str(p, v, spec.values, true); break
      case 'noise': checkNoise(c, p, v, true); break
      case 'bool': c.bool(p, v, true); break
      case 'biome': c.str(p, v, ctx.biomes); break
    }
  }
}

/** `def.params` (already validated) with every missing param set to its schema default. */
export function paramsOf<S extends ParamSchema>(def: OpDef, schema: S): ParamValues<S> {
  const out: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(schema)) {
    const v = def.params[key]
    out[key] = v !== undefined ? v : 'default' in spec ? spec.default : undefined
  }
  return out as ParamValues<S>
}
