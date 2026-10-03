import { BRICK_VALUES, HEIGHT_VALUES, TILE } from '@elovox/terrain'
import { describe, expect, it } from 'vitest'
import { BrickWriter, TileWriter, replaceLayer } from '../src/core/layerWriter.ts'

const i16 = (n: number) => new Int16Array(n)

describe('TileWriter', () => {
  it('reads 0 where there is no tile, copies a tile on its first write and shares the rest', () => {
    const a = { x: 0, z: 0, values: i16(HEIGHT_VALUES) }
    a.values[5] = 3
    const b = { x: 2, z: 1, values: i16(HEIGHT_VALUES).fill(1) }
    const w = new TileWriter([a, b], TILE, i16)
    expect(w.get(5, 0)).toBe(3)
    expect(w.get(64, 0)).toBe(0)
    w.set(6, 0, 9)
    w.set(7, 0, 10) // reuses the copy
    const out = w.result()!
    expect(out[0]!.values[6]).toBe(9)
    expect(out[0]!.values[7]).toBe(10)
    expect(out[0]!.values[5]).toBe(3)
    expect(a.values[6]).toBe(0) // the input is untouched
    expect(out[1]).toBe(b)
    expect(w.changed).toBe(true)
  })

  it('creates tiles in order and drops tiles left all zero', () => {
    const a = { x: 0, z: 0, values: i16(HEIGHT_VALUES) }
    a.values[0] = 4
    const w = new TileWriter([a], TILE, i16)
    w.set(130, 70, 2) // tile (2, 1)
    w.set(70, 0, 1) // tile (1, 0)
    w.set(0, 0, 0) // tile (0, 0) is now all zero
    expect(w.result()!.map((t) => [t.x, t.z])).toEqual([[1, 0], [2, 1]])
    const empty = new TileWriter([a], TILE, i16)
    empty.set(0, 0, 0)
    expect(empty.result()).toBeUndefined()
  })

  it('writing 0 where there is no tile creates nothing', () => {
    const w = new TileWriter(undefined, TILE, i16)
    w.set(3, 3, 0)
    expect(w.changed).toBe(false)
    expect(w.result()).toBeUndefined()
  })
})

describe('BrickWriter', () => {
  it('reads and writes samples by global sample coordinates, sorted by y, z, x', () => {
    const w = new BrickWriter(undefined)
    w.set(9, 0, 0, 5) // brick (1, 0, 0), local (1, 0, 0)
    w.set(0, 8, 0, -3) // brick (0, 1, 0)
    w.set(0, 0, 9, 7) // brick (0, 0, 1)
    expect(w.get(9, 0, 0)).toBe(5)
    expect(w.result()!.map((b) => [b.x, b.y, b.z])).toEqual([[1, 0, 0], [0, 0, 1], [0, 1, 0]])
    expect(w.result()![0]!.values[1]).toBe(5)
    expect(w.result()![0]!.values.length).toBe(BRICK_VALUES)
  })
})

describe('replaceLayer', () => {
  it('replaces or removes one layer and keeps the others', () => {
    const height = { tiles: [{ x: 0, z: 0, values: i16(HEIGHT_VALUES).fill(1) }] }
    const density = { bricks: [] }
    expect(replaceLayer({ height, density }, { height: undefined })).toEqual({ density })
    const tiles = [{ x: 1, z: 1, values: i16(HEIGHT_VALUES).fill(2) }]
    expect(replaceLayer({ height }, { height: tiles })).toEqual({ height: { tiles } })
  })
})
