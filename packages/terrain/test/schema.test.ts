import { describe, expect, it } from 'vitest'
import { Check } from '../src/doc/check.ts'
import type { OpDef } from '../src/doc/types.ts'
import { BELOW_TOP, WORLD_TOP, checkParams, paramsOf, resolveBound, type ParamSchema } from '../src/ops/schema.ts'

const SCHEMA = {
  size: { type: 'number', required: true, default: 4, min: 0, max: WORLD_TOP },
  level: { type: 'number', default: 2, int: true, gt: 0, max: BELOW_TOP },
  thick: { type: 'number', gt: 0 },
  shape: { type: 'enum', values: ['round', 'box'], default: 'round' },
  noise: { type: 'noise', default: { scale: 32 } },
  solid: { type: 'bool', default: true },
  biome: { type: 'biome' },
} as const satisfies ParamSchema

const ctx = { biomes: ['plain', 'mesa'], height: 64 }
const def = (params: Record<string, unknown>): OpDef =>
  ({ id: 'a', type: 't', enabled: true, shape: { kind: 'circle', center: [0, 0], radius: 1 }, params })
function errors(params: Record<string, unknown>, schema: ParamSchema = SCHEMA): string[] {
  const c = new Check()
  checkParams(c, 'ops[0]', def(params), schema, ctx)
  return c.errors
}

describe('checkParams', () => {
  it('accepts valid params and missing optional ones', () => {
    expect(errors({ size: 3, biome: 'mesa' })).toEqual([])
  })

  it('reports each bad param with its path, in schema order', () => {
    expect(errors({ size: 65, level: 1.5, thick: 0, shape: 'blob', noise: { scale: 0 }, solid: 'yes', biome: 'swamp' })).toEqual([
      'ops[0].params.size: must be <= 64',
      'ops[0].params.level: must be an integer',
      'ops[0].params.thick: must be > 0',
      'ops[0].params.shape: must be one of round, box',
      'ops[0].params.noise.scale: must be > 0',
      'ops[0].params.solid: must be true or false',
      'ops[0].params.biome: must be one of plain, mesa',
    ])
  })

  it('requires required numbers and biome params', () => {
    expect(errors({})).toEqual(['ops[0].params.size: is required', 'ops[0].params.biome: is required'])
  })

  it('rejects unknown params first, naming the known ones', () => {
    expect(errors({ size: 1, biome: 'plain', sise: 2 })).toEqual([
      'ops[0].params.sise: unknown param (known: size, level, thick, shape, noise, solid, biome)',
    ])
  })

  it('says when an op takes no params at all', () => {
    expect(errors({ x: 1 }, {})).toEqual(['ops[0].params.x: unknown param (this op takes none)'])
  })

  it('does not mistake inherited object keys for params', () => {
    expect(errors({ size: 1, biome: 'plain', toString: 2 })).toEqual([
      'ops[0].params.toString: unknown param (known: size, level, thick, shape, noise, solid, biome)',
    ])
  })
})

describe('paramsOf', () => {
  it('fills defaults and leaves a param without one undefined', () => {
    expect(paramsOf(def({ size: 3, biome: 'mesa' }), SCHEMA)).toEqual({
      size: 3, level: 2, thick: undefined, shape: 'round', noise: { scale: 32 }, solid: true, biome: 'mesa',
    })
  })

  it('keeps given values, falsy ones included', () => {
    expect(paramsOf(def({ size: 0, solid: false, biome: 'plain' }), SCHEMA)).toMatchObject({ size: 0, solid: false })
  })

  it('is typed from the schema', () => {
    const p = paramsOf(def({ size: 3, biome: 'mesa' }), SCHEMA)
    const size: number = p.size
    const thick: number | undefined = p.thick
    const shape: 'round' | 'box' = p.shape
    expect([size, thick, shape]).toEqual([3, undefined, 'round'])
  })
})

describe('resolveBound', () => {
  it('resolves world-relative bounds and passes numbers through', () => {
    expect(resolveBound(WORLD_TOP, ctx)).toBe(64)
    expect(resolveBound(BELOW_TOP, ctx)).toBe(63)
    expect(resolveBound(5, ctx)).toBe(5)
    expect(resolveBound(undefined, ctx)).toBeUndefined()
  })
})
