import { BIOME_VALUES, BRICK_VALUES, HEIGHT_VALUES, type HeightTile, type TerrainDoc } from '@elovox/terrain'
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

describe('diffArea: layers', () => {
  const withHeight = (d: TerrainDoc, tiles: HeightTile[]): TerrainDoc => ({ ...d, layers: { ...d.layers, height: { tiles } } })
  // Column (100, 50) is index (100 - 64) + 50 * 64 of tile (1, 0).
  function tile(): HeightTile {
    const values = new Int16Array(HEIGHT_VALUES)
    values[100 - 64 + 50 * 64] = 16
    return { x: 1, z: 0, values }
  }
  // (100, 50) padded by AREA_PAD (8): 92..109 × 42..59, rounded out to chunk columns.
  const area = { x0: 64, z0: 32, x1: 128, z1: 64 }

  it('covers the changed columns, padded and rounded, never the whole world', () => {
    const d = doc()
    expect(diffArea(d, withHeight(d, [tile()]), o)).toEqual(area)
  })

  it('covers a removed tile', () => {
    const d = doc()
    expect(diffArea(withHeight(d, [tile()]), d, o)).toEqual(area)
  })

  it('skips tiles both documents share, and finds nothing between equal copies', () => {
    const d = doc()
    const t = tile()
    const a = withHeight(d, [t])
    expect(diffArea(a, { ...a, layers: { height: { tiles: [t] } } }, o)).toBeNull()
    expect(diffArea(a, withHeight(d, [{ ...t, values: t.values.slice() }]), o)).toBeNull()
  })

  it('covers a biome cell as its 4 × 4 columns', () => {
    const d = doc()
    const values = new Uint8Array(BIOME_VALUES)
    values[5 + 2 * 16] = 1 // cell (5, 2): columns 20..23 × 8..11
    expect(diffArea(d, { ...d, layers: { biome: { tiles: [{ x: 0, z: 0, values }] } } }, o)).toEqual({ x0: 0, z0: 0, x1: 32, z1: 32 })
  })

  it('reaches two blocks around a changed density sample', () => {
    const d = doc()
    const values = new Int8Array(BRICK_VALUES)
    values[0] = 8 // sample (0, 0, 0) of brick (6, 1, 3) = block (96, 16, 48): 94..98 × 46..50
    expect(diffArea(d, { ...d, layers: { density: { bricks: [{ x: 6, y: 1, z: 3, values }] } } }, o)).toEqual({ x0: 64, z0: 32, x1: 128, z1: 64 })
  })
})
