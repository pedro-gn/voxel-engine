import { describe, expect, it } from 'vitest'
import { validateTerrainDoc } from '../src/doc/validate.ts'
import { BUILTIN_OPS } from '../src/ops/builtin.ts'
import { minimalDoc } from './fixtures.ts'

describe('built-in op schemas', () => {
  it.each(BUILTIN_OPS.map((o) => [o.type, o] as const))('%s: required numbers have a default, anchored ones are required', (_type, impl) => {
    for (const [key, spec] of Object.entries(impl.params)) {
      if (spec.type !== 'number') continue
      if (spec.required) expect(spec.default, key).toBeTypeOf('number')
      if (spec.anchor) expect(spec.required, key).toBe(true)
    }
  })

  it('only hills, flatten and biome use a falloff', () => {
    expect(BUILTIN_OPS.filter((o) => o.falloff).map((o) => o.type).sort()).toEqual(['biome', 'flatten', 'hills'])
  })

  it('rejects a falloff on an op that ignores it, and unknown params', () => {
    const circle = (falloff: number) => ({ kind: 'circle', center: [10, 10], radius: 5, falloff })
    const doc = {
      ...minimalDoc(),
      ops: [
        { id: 'm', type: 'mountain', shape: circle(4), params: { height: 10 } },
        { id: 'z', type: 'mountain', shape: circle(0), params: { height: 10 } },
        { id: 'h', type: 'hills', shape: circle(4), params: { amplitude: 3, amplitdue: 4 } },
      ],
    }
    const r = validateTerrainDoc(doc)
    expect(r.ok ? [] : r.errors).toEqual([
      'ops[0].shape.falloff: mountain does not use a falloff',
      'ops[2].params.amplitdue: unknown param (known: amplitude, offset, noise)',
    ])
  })
})
