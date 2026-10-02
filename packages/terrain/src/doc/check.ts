import { NOISE_TYPES } from '../noise/def.ts'

export interface NumOpts { min?: number; max?: number; int?: boolean; optional?: boolean; gt?: number }

/** Collects validation errors as "path: message" without stopping at the first one. */
export class Check {
  readonly errors: string[] = []

  fail(path: string, message: string): void { this.errors.push(`${path}: ${message}`) }

  obj(path: string, v: unknown, optional = false): v is Record<string, unknown> {
    if (v === undefined && optional) return false
    if (typeof v !== 'object' || v === null || Array.isArray(v)) { this.fail(path, v === undefined ? 'is required' : 'must be an object'); return false }
    return true
  }

  arr(path: string, v: unknown, min = 0, optional = false): v is unknown[] {
    if (v === undefined && optional) return false
    if (!Array.isArray(v)) { this.fail(path, v === undefined ? 'is required' : 'must be an array'); return false }
    if (v.length < min) { this.fail(path, `must have at least ${min} item${min === 1 ? '' : 's'}`); return false }
    return true
  }

  num(path: string, v: unknown, o: NumOpts = {}): v is number {
    if (v === undefined && o.optional) return false
    if (typeof v !== 'number' || !Number.isFinite(v)) { this.fail(path, v === undefined ? 'is required' : 'must be a finite number'); return false }
    if (o.int && !Number.isInteger(v)) { this.fail(path, 'must be an integer'); return false }
    if (o.min !== undefined && v < o.min) { this.fail(path, `must be >= ${o.min}`); return false }
    if (o.gt !== undefined && v <= o.gt) { this.fail(path, `must be > ${o.gt}`); return false }
    if (o.max !== undefined && v > o.max) { this.fail(path, `must be <= ${o.max}`); return false }
    return true
  }

  str(path: string, v: unknown, oneOf?: readonly string[], optional = false): v is string {
    if (v === undefined && optional) return false
    if (typeof v !== 'string' || v.length === 0) { this.fail(path, v === undefined ? 'is required' : 'must be a non-empty string'); return false }
    if (oneOf && !oneOf.includes(v)) { this.fail(path, `must be one of ${oneOf.join(', ')}`); return false }
    return true
  }

  bool(path: string, v: unknown, optional = false): v is boolean {
    if (v === undefined && optional) return false
    if (typeof v !== 'boolean') { this.fail(path, v === undefined ? 'is required' : 'must be true or false'); return false }
    return true
  }

  /** [a, b] with a <= b. */
  range(path: string, v: unknown, optional = false): v is [number, number] {
    if (v === undefined && optional) return false
    if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number' && !Number.isNaN(n))) {
      this.fail(path, 'must be [min, max]')
      return false
    }
    if (v[0] > v[1]) { this.fail(path, 'min must be <= max'); return false }
    return true
  }

  /** [x, z] of finite numbers. */
  vec2(path: string, v: unknown): v is [number, number] {
    if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      this.fail(path, 'must be [x, z]')
      return false
    }
    return true
  }
}

/** Validates a NoiseDef (see noise/def.ts). */
export function checkNoise(c: Check, path: string, v: unknown, optional = false): void {
  if (!c.obj(path, v, optional)) return
  c.str(`${path}.type`, v.type, NOISE_TYPES, true)
  c.num(`${path}.scale`, v.scale, { gt: 0 })
  c.num(`${path}.octaves`, v.octaves, { int: true, min: 1, max: 8, optional: true })
  c.num(`${path}.lacunarity`, v.lacunarity, { gt: 0, optional: true })
  c.num(`${path}.gain`, v.gain, { gt: 0, max: 1, optional: true })
  c.num(`${path}.seed`, v.seed, { int: true, optional: true })
  if (c.obj(`${path}.warp`, v.warp, true)) {
    c.num(`${path}.warp.scale`, v.warp.scale, { gt: 0 })
    c.num(`${path}.warp.amount`, v.warp.amount, { min: 0 })
  }
}
