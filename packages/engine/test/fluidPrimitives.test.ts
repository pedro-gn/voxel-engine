import { describe, expect, it } from 'vitest'
import { BlockRegistry, defineBlock } from '../src/blocks/registry.ts'
import { ActiveQueue } from '../src/sim/fluids/activeQueue.ts'
import { FULL, SPRING_RATES, flowGroup, isSource, liquidVoxel, volumeOf } from '../src/sim/fluids/cell.ts'
import { ChunkBits } from '../src/sim/fluids/chunkBits.ts'
import { ContactTable } from '../src/sim/fluids/contacts.ts'
import { PoolTable } from '../src/sim/fluids/pools.ts'
import { SurfaceIndex } from '../src/sim/fluids/surfaceIndex.ts'
import { Layout } from '../src/world/layout.ts'
import { AIR, packVoxel } from '../src/world/voxel.ts'

const reg = new BlockRegistry([
  defineBlock({ name: 'stone' }),
  defineBlock({ name: 'water', liquid: true }),
  defineBlock({ name: 'spring', liquid: true, source: 'water', textures: 'water' }),
])
const [STONE, WATER, SPRING] = [1, 2, 3]

describe('cell helpers', () => {
  it('reads volumes and groups', () => {
    expect(volumeOf(reg, packVoxel(WATER, 0))).toBe(1)
    expect(volumeOf(reg, packVoxel(WATER, 7))).toBe(FULL)
    expect(volumeOf(reg, packVoxel(SPRING, 2))).toBe(FULL) // a spring counts as full whatever its state
    expect(volumeOf(reg, STONE)).toBe(0)
    expect(flowGroup(reg, packVoxel(WATER, 3))).toBe(WATER)
    expect(flowGroup(reg, SPRING)).toBe(0)
    expect(flowGroup(reg, AIR)).toBe(0)
    expect(isSource(reg, SPRING)).toBe(true)
    expect(liquidVoxel(WATER, 3)).toBe(packVoxel(WATER, 2))
    expect(liquidVoxel(WATER, 0)).toBe(AIR)
    expect(() => liquidVoxel(WATER, 9)).toThrow(RangeError)
    expect(SPRING_RATES).toHaveLength(16)
  })
})

describe('ChunkBits and SurfaceIndex', () => {
  const L = new Layout([64, 64, 64])
  it('stores bits per chunk and ignores out-of-world coordinates', () => {
    const b = new ChunkBits(L)
    b.add(1, 2, 3); b.add(63, 63, 63); b.add(64, 0, 0); b.add(-1, 0, 0)
    expect([b.has(1, 2, 3), b.has(63, 63, 63), b.has(0, 2, 3), b.has(64, 0, 0), b.has(-1, 0, 0)]).toEqual([true, true, false, false, false])
    expect(b.count()).toBe(2)
    b.delete(1, 2, 3)
    expect(b.has(1, 2, 3)).toBe(false)
  })
  it('maps surface cells to pool ids in tiles', () => {
    const s = new SurfaceIndex(L)
    const k = s.set(40, 7, 9, 5)
    expect(s.get(40, 7, 9)).toBe(5)
    expect(s.get(40, 8, 9)).toBe(0)
    expect(s.origin(k)).toEqual([32, 7, 0])
    expect(s.key(33, 7, 31)).toBe(k)
    s.delete(40, 7, 9)
    expect(s.get(40, 7, 9)).toBe(0)
    expect(s.get(-1, 0, 0)).toBe(0)
  })
})

describe('PoolTable', () => {
  const L = new Layout([32, 32, 32])
  function table() {
    const index = new SurfaceIndex(L), members = new ChunkBits(L)
    return { index, members, pools: new PoolTable(L, index, members) }
  }
  it('finds the owner of a cell by walking up to its surface', () => {
    const { index, members, pools } = table()
    const p = pools.create(WATER, 5, 7)
    for (let y = 2; y <= 5; y++) members.add(4, y, 4)
    index.set(4, 5, 4, p.id)
    expect(pools.ownerOf(4, 2, 4)).toBe(p)
    expect(pools.ownerOf(4, 6, 4)).toBeUndefined()
    expect(pools.ownerOf(5, 2, 4)).toBeUndefined()
  })
  it('uses the capped map for a column top below the surface', () => {
    const { members, pools } = table()
    const p = pools.create(WATER, 9, 7)
    members.add(1, 3, 1); members.add(1, 4, 1)
    pools.capped.set(L.voxelIndex(1, 4, 1), p.id)
    expect(pools.ownerOf(1, 3, 1)).toBe(p)
  })
  it('merges by alias and resolves chains', () => {
    const { pools } = table()
    const a = pools.create(WATER, 5, 3), b = pools.create(WATER, 5, 3), c = pools.create(WATER, 5, 3)
    a.area = 2; b.area = 3; c.area = 4
    a.grid = 8; b.grid = 12; c.grid = 16
    b.balance = -1; c.cycle = true
    b.outlets.add(77)
    pools.merge(b, c)
    pools.merge(a, b)
    expect(pools.resolve(c.id)).toBe(a.id)
    expect(pools.get(c.id)).toBe(a)
    expect([a.area, a.grid, a.balance, a.cycle, a.outlets.has(77)]).toEqual([9, 36, -1, true, true])
    expect(pools.all()).toEqual([a])
    pools.remove(a)
    expect(pools.get(c.id)).toBeUndefined()
  })
})

describe('ContactTable', () => {
  it('stores each face once, keyed by the lower pool id', () => {
    const t = new ContactTable()
    t.add(5, 100, 2, 200)
    t.add(2, 200, 5, 100)
    t.add(2, 201, 5, 101)
    const [c] = t.all()
    expect(c).toMatchObject({ a: 2, b: 5, faces: [[200, 100], [201, 101]] })
    t.delete(c!)
    expect(t.size).toBe(0)
  })
})

describe('ActiveQueue', () => {
  it('takes cells in order, once each, and keeps idle counts', () => {
    const q = new ActiveQueue()
    q.add(1); q.add(2); q.add(1); q.add(3)
    expect(q.take(2)).toEqual([1, 2])
    q.requeue(1)
    q.drop(2)
    expect(q.take(10)).toEqual([3, 1])
    expect([q.has(1), q.has(2), q.size]).toEqual([true, false, 2])
    expect(q.rest(1)).toBe(1)
    expect(q.rest(1)).toBe(2)
    q.add(1) // waking resets the idle count
    expect(q.rest(1)).toBe(1)
  })
  it('does not hand out a dropped and re-added cell twice in one take', () => {
    const q = new ActiveQueue()
    q.add(7); q.drop(7); q.add(7)
    expect(q.take(10)).toEqual([7])
  })
})
