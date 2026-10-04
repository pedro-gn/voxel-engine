import { describe, expect, it } from 'vitest'
import { BlockRegistry, defineBlock } from '../src/blocks/registry.ts'
import { SUB } from '../src/sim/water/constants.ts'
import { WaterMirror, quantize } from '../src/sim/water/mirror.ts'
import { waterKinds } from '../src/sim/water/rebuild.ts'
import { AIR, packVoxel } from '../src/world/voxel.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'

const reg = new BlockRegistry([...TEST_BLOCKS, defineBlock({ name: 'spring', liquid: true, source: 'water', textures: 'water' })])
const kind = waterKinds(reg, ID.water)
const SPRING = 8
const water = (level: number) => packVoxel(ID.water, level)

/** One column at (0, 0): y → voxel. */
function column() {
  const cells = new Map<number, number>()
  return {
    cells,
    get: (_x: number, y: number, _z: number) => cells.get(y) ?? AIR,
    set: (_x: number, y: number, _z: number, v: number) => { if (v === AIR) cells.delete(y); else cells.set(y, v) },
  }
}

/** A mirror whose single column was rebuilt dry at `floor`. */
function mirrorAt(floor: number): WaterMirror {
  const m = new WaterMirror(1)
  m.lo[0] = floor
  m.q[0] = floor * 8
  return m
}

describe('quantize', () => {
  it('rounds the surface to eighths; less than 1/16 block over a cell top is no water', () => {
    expect(quantize(4 * SUB + 15)).toBe(32)
    expect(quantize(4 * SUB + 16)).toBe(33)
    expect(quantize(4 * SUB + 239)).toBe(39)
    expect(quantize(4 * SUB + 240)).toBe(40)
  })
})

describe('WaterMirror', () => {
  it('writes full cells under the quantized surface and a partial cell at it', () => {
    const m = mirrorAt(2), w = column()
    expect(m.flush(0, 0, 0, 2, 2 * SUB + 100, ID.water, kind, 32, w.get, w.set)).toBe(true)
    expect([...w.cells].sort((a, b) => a[0] - b[0])).toEqual([[2, water(7)], [3, water(7)], [4, water(2)]])
    expect(m.flush(0, 0, 0, 2, 2 * SUB + 100, ID.water, kind, 32, w.get, w.set)).toBe(false) // nothing changed
  })

  it('clears what is above a lower surface, and everything once the column is dry', () => {
    const m = mirrorAt(2), w = column()
    m.flush(0, 0, 0, 2, 3 * SUB, ID.water, kind, 32, w.get, w.set)
    m.flush(0, 0, 0, 2, SUB, ID.water, kind, 32, w.get, w.set)
    expect([...w.cells.keys()]).toEqual([2])
    m.flush(0, 0, 0, 2, 0, ID.water, kind, 32, w.get, w.set)
    expect(w.cells.size).toBe(0)
  })

  it('empties the cells a risen floor left under it, and leaves static water further down alone', () => {
    const m = mirrorAt(2), w = column()
    w.cells.set(1, water(7)) // static, under the floor
    m.flush(0, 0, 0, 2, 3 * SUB, ID.water, kind, 32, w.get, w.set)
    w.cells.set(4, ID.stone) // a wall dropped in the water: the floor is now 5, the water pushed up
    m.flush(0, 0, 0, 5, 3 * SUB, ID.water, kind, 32, w.get, w.set)
    expect([...w.cells].sort((a, b) => a[0] - b[0])).toEqual([[1, water(7)], [4, ID.stone], [5, water(7)], [6, water(7)], [7, water(7)]])
  })

  it('never writes a wall or a spring inside the water (a floating block, a spring)', () => {
    const m = mirrorAt(2), w = column()
    w.cells.set(3, ID.stone)
    w.cells.set(5, packVoxel(SPRING, 2))
    m.flush(0, 0, 0, 2, 5 * SUB, ID.water, kind, 32, w.get, w.set)
    expect([2, 3, 4, 5, 6].map((y) => w.get(0, y, 0))).toEqual([water(7), ID.stone, water(7), packVoxel(SPRING, 2), water(7)])
  })

  it('rewrites a touched column up to the touched cell: a stray water voxel above the surface goes', () => {
    const m = mirrorAt(2), w = column()
    m.flush(0, 0, 0, 2, SUB, ID.water, kind, 32, w.get, w.set)
    w.cells.set(10, water(7)) // a command placed it; its volume already joined the column
    expect(m.flush(0, 0, 0, 2, SUB, ID.water, kind, 32, w.get, w.set)).toBe(false)
    m.touch(0, 10)
    expect(m.flush(0, 0, 0, 2, SUB, ID.water, kind, 32, w.get, w.set)).toBe(true)
    expect([...w.cells.keys()]).toEqual([2])
  })
})
