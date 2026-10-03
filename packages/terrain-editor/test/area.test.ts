import { describe, expect, it } from 'vitest'
import { diffArea, toArea, unionArea } from '../src/core/area.ts'
import { addOp, removeOp, reorderOp, setBase, setParam, setSeaLevel, setShape } from '../src/core/edits.ts'
import { HEIGHT, SIZE, doc } from './fixtures.ts'

const o = { height: HEIGHT }

describe('toArea', () => {
  it('pads by what a column reads from its neighbours and rounds out to chunk columns', () => {
    expect(toArea({ x0: 44, z0: 44, x1: 84, z1: 84 }, SIZE)).toEqual({ x0: 32, z0: 32, x1: 96, z1: 96 })
  })

  it('clips to the world and is null fully outside it', () => {
    expect(toArea({ x0: -50, z0: 240, x1: 10, z1: 300 }, SIZE)).toEqual({ x0: 0, z0: 224, x1: 32, z1: 256 })
    expect(toArea({ x0: -100, z0: 0, x1: -20, z1: 10 }, SIZE)).toBeNull()
  })
})

describe('unionArea', () => {
  it('combines rectangles, absorbs null and is swallowed by all', () => {
    const a = { x0: 0, z0: 0, x1: 32, z1: 32 }, b = { x0: 64, z0: 32, x1: 96, z1: 64 }
    expect(unionArea(a, b)).toEqual({ x0: 0, z0: 0, x1: 96, z1: 64 })
    expect(unionArea(null, a)).toBe(a)
    expect(unionArea(a, null)).toBe(a)
    expect(unionArea(a, 'all')).toBe('all')
    expect(unionArea(null, null)).toBeNull()
  })
})

describe('diffArea', () => {
  // hill: circle (64, 64) r 20 falloff 8 → bounds 36..92 → padded and rounded: 0..128.
  const hillArea = { x0: 0, z0: 0, x1: 128, z1: 128 }

  it('is null for the same or an equal document', () => {
    const d = doc()
    expect(diffArea(d, d, o)).toBeNull()
    expect(diffArea(d, doc(), o)).toBeNull()
  })

  it('covers a changed op', () => {
    const d = doc()
    expect(diffArea(d, setParam('hill', 'amplitude', 3)(d), o)).toEqual(hillArea)
  })

  it('covers where a moved op was and where it is', () => {
    const d = doc()
    const moved = setShape('hill', { kind: 'circle', center: [200, 64], radius: 20, falloff: 8 })(d)
    expect(diffArea(d, moved, o)).toEqual({ x0: 0, z0: 0, x1: 256, z1: 128 })
  })

  it('covers an added or removed op', () => {
    const d = doc()
    const flat = { id: 'f', type: 'flatten', enabled: true, shape: { kind: 'circle' as const, center: [16, 240] as [number, number], radius: 4 }, params: { y: 30 } }
    expect(diffArea(d, addOp(flat)(d), o)).toEqual({ x0: 0, z0: 224, x1: 32, z1: 256 })
    expect(diffArea(d, removeOp('hill')(d), o)).toEqual(hillArea)
  })

  it('covers both ops of a swap', () => {
    const d = doc()
    // ridge: path (150,40)-(200,90) w 24 → 138..212 × 28..102 → 128..224 × 0..128; pond: lake 100..140 × 180..220 + shore 16 → 84..156 × 164..236 → 64..192 × 128..256.
    expect(diffArea(d, reorderOp('ridge', 1)(d), o)).toEqual({ x0: 64, z0: 0, x1: 224, z1: 256 })
  })

  it('is the whole world for a change outside the ops', () => {
    const d = doc()
    expect(diffArea(d, setSeaLevel(12)(d), o)).toBe('all')
    expect(diffArea(d, setBase({ ...d.base, height: 40 })(d), o)).toBe('all')
  })
})
