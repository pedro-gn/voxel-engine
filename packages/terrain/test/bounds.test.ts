import { describe, expect, it } from 'vitest'
import type { OpDef, TerrainDoc } from '../src/doc/types.ts'
import { validateTerrainDoc } from '../src/doc/validate.ts'
import { opBounds } from '../src/ops/bounds.ts'
import { minimalDoc } from './fixtures.ts'

function doc(): TerrainDoc {
  const r = validateTerrainDoc(minimalDoc())
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return r.doc
}
const op = (o: Omit<OpDef, 'enabled'> & { enabled?: boolean }): OpDef => ({ enabled: true, ...o })

describe('opBounds', () => {
  it('is the compiled bounds of a height op, falloff included', () => {
    const def = op({ id: 'h', type: 'hills', shape: { kind: 'circle', center: [100, 100], radius: 20, falloff: 10 }, params: { amplitude: 4 } })
    expect(opBounds(def, doc())).toEqual({ x0: 70, z0: 70, x1: 130, z1: 130 })
  })

  it('includes reach the shape does not show, like river banks', () => {
    const def = op({ id: 'r', type: 'river', shape: { kind: 'path', width: 10, points: [{ x: 0, z: 50 }, { x: 100, z: 50 }] }, params: { start: 20, end: 12 } })
    expect(opBounds(def, doc())).toEqual({ x0: -21, z0: 29, x1: 121, z1: 71 })
  })

  it('drops the y of a volume op', () => {
    const def = op({ id: 'b', type: 'blob', shape: { kind: 'circle', center: [50, 60], radius: 10 }, params: { y: 30, height: 5, wobble: 0 } })
    expect(opBounds(def, doc())).toEqual({ x0: 40, z0: 50, x1: 60, z1: 70 })
  })

  it('works for a biome op and a disabled op', () => {
    const def = op({ id: 'p', type: 'biome', enabled: false, shape: { kind: 'circle', center: [10, 10], radius: 5 }, params: { biome: 'beach' } })
    expect(opBounds(def, doc())).toEqual({ x0: 5, z0: 5, x1: 15, z1: 15 })
  })

  it('throws for an unknown op type', () => {
    expect(() => opBounds(op({ id: 'v', type: 'volcano', shape: { kind: 'circle', center: [0, 0], radius: 1 }, params: {} }), doc())).toThrow('unknown op type "volcano"')
  })
})
