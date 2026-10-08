import { describe, expect, it } from 'vitest'
import { BlockRegistry, defineBlock } from '../src/blocks/registry.ts'
import {
  bodyBox, boxOverlapsSolid,
  type Box, type CollisionWorld,
} from '../src/interact/collision.ts'
import type { WorldSize } from '../src/world/layout.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'

const REG = new BlockRegistry([...TEST_BLOCKS, defineBlock({ name: 'spring', textures: 'water', liquid: true, source: 'water' })])
const STONE = ID.stone, WATER = ID.water, SPRING = 8

function makeWorld(size: WorldSize = [64, 64, 64]) {
  const cells = new Map<number, number>()
  const key = (x: number, y: number, z: number) => x + z * size[0] + y * size[0] * size[2]
  const world: CollisionWorld = { size, get: (x, y, z) => cells.get(key(x, y, z)) ?? 0, solid: REG.solid, liquid: REG.liquid, source: REG.source }
  const set = (x: number, y: number, z: number, v: number) => { cells.set(key(x, y, z), v) }
  const fill = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, v: number) => {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) set(x, y, z, v)
  }
  return { world, set, fill }
}
/** The standard test body: 0.6 wide, 1.8 tall, feet centre (x, y, z). */
const body = (x: number, y: number, z: number): Box => bodyBox(x, y, z, 0.3, 1.8)

describe('bodyBox and boxOverlapsSolid', () => {
  it('builds a feet-centred box', () => {
    expect(bodyBox(10.5, 5, 10.5, 0.3, 1.8)).toEqual({ minX: 10.5 - 0.3, minY: 5, minZ: 10.5 - 0.3, maxX: 10.5 + 0.3, maxY: 5 + 1.8, maxZ: 10.5 + 0.3 })
  })
  it('overlaps a solid voxel inside the box, never a liquid one', () => {
    const { world, set } = makeWorld()
    set(10, 6, 10, WATER)
    expect(boxOverlapsSolid(world, body(10.5, 5, 10.5))).toBe(false)
    set(10, 6, 10, STONE)
    expect(boxOverlapsSolid(world, body(10.5, 5, 10.5))).toBe(true)
  })
  it('does not count touching faces or float residue as overlap', () => {
    const { world, set } = makeWorld()
    set(10, 4, 10, STONE); set(11, 5, 10, STONE)
    expect(boxOverlapsSolid(world, body(10.5, 5, 10.5))).toBe(false)
    expect(boxOverlapsSolid(world, body(10.5, 5 - 1e-9, 10.5))).toBe(false)
    expect(boxOverlapsSolid(world, body(10.7, 5, 10.5))).toBe(false)
    expect(boxOverlapsSolid(world, body(10.701, 5, 10.5))).toBe(true)
  })
  it('treats the sides and the floor as solid and above the top as air', () => {
    const { world } = makeWorld()
    expect(boxOverlapsSolid(world, body(0.2, 5, 10.5))).toBe(true)
    expect(boxOverlapsSolid(world, body(63.8, 5, 10.5))).toBe(true)
    expect(boxOverlapsSolid(world, body(10.5, 5, 0.2))).toBe(true)
    expect(boxOverlapsSolid(world, body(10.5, 5, 63.8))).toBe(true)
    expect(boxOverlapsSolid(world, body(10.5, -0.1, 10.5))).toBe(true)
    expect(boxOverlapsSolid(world, body(10.5, 0, 10.5))).toBe(false)
    expect(boxOverlapsSolid(world, body(10.5, 63, 10.5))).toBe(false)
    expect(boxOverlapsSolid(world, body(10.5, 1e9, 10.5))).toBe(false)
    expect(boxOverlapsSolid(world, body(63.8, 100, 10.5))).toBe(true)
  })
  it('a non-finite box overlaps nothing', () => {
    const { world } = makeWorld()
    expect(boxOverlapsSolid(world, body(NaN, 5, 10.5))).toBe(false)
    expect(boxOverlapsSolid(world, { ...body(10.5, 5, 10.5), maxY: Infinity })).toBe(false)
  })
})
