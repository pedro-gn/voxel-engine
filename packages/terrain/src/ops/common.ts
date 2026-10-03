import { Check, checkNoise } from '../doc/check.ts'
import type { OpDef } from '../doc/types.ts'
import { makeNoise2, makeNoise3, type NoiseDef, type Sampler2, type Sampler3 } from '../noise/def.ts'
import { PROFILES, type Profile } from '../shapes/profile.ts'

/** Typed reads of already-validated params. */
export function param(def: OpDef, key: string, fallback: number): number {
  const v = def.params[key]
  return typeof v === 'number' ? v : fallback
}
export function paramStr<T extends string>(def: OpDef, key: string, fallback: T): T {
  const v = def.params[key]
  return typeof v === 'string' ? (v as T) : fallback
}
export function noise2Of(def: OpDef, key: string, fallback: NoiseDef, seed: number): Sampler2 {
  return makeNoise2((def.params[key] as NoiseDef | undefined) ?? fallback, seed)
}
export function noise3Of(def: OpDef, key: string, fallback: NoiseDef, seed: number): Sampler3 {
  return makeNoise3((def.params[key] as NoiseDef | undefined) ?? fallback, seed)
}

/** Validation shorthands for `${path}.params.<key>`. */
export function checkParamNum(c: Check, path: string, def: OpDef, key: string, o: Parameters<Check['num']>[2]): void {
  c.num(`${path}.params.${key}`, def.params[key], o)
}
export function checkParamProfile(c: Check, path: string, def: OpDef, key = 'profile'): void {
  c.str(`${path}.params.${key}`, def.params[key], PROFILES, true)
}
export function checkParamNoise(c: Check, path: string, def: OpDef, key = 'noise'): void {
  checkNoise(c, `${path}.params.${key}`, def.params[key], true)
}
export function checkParamMode(c: Check, path: string, def: OpDef): void {
  c.str(`${path}.params.mode`, def.params.mode, ['add', 'carve'], true)
}

export type { Profile }
