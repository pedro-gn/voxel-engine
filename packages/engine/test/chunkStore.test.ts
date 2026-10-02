import { describe, expect, it } from 'vitest'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ChunkStore, WorldFullError } from '../src/world/chunkStore.ts'
import { AIR, FULL_SKY } from '../src/world/voxel.ts'
import { ID, testRegistry } from './helpers.ts'

const reg = testRegistry()
function makeStore(size: [number, number, number], maxPages?: number) {
  const pages: number[] = []
  const store = new ChunkStore({
    buffers: createWorldBuffers(size), opaque: reg.opaque, maxPages,
    onNewPage: (i) => pages.push(i),
  })
  return { store, pages }
}

describe('ChunkStore', () => {
  it('starts as uniform air with full sky light', () => {
    const { store } = makeStore([64, 64, 64])
    expect(store.getVoxel(3, 4, 5)).toBe(AIR)
    expect(store.getLight(3, 4, 5)).toBe(FULL_SKY)
    expect(store.slotsUsed()).toBe(0)
    expect(store.getVoxel(-1, 0, 0)).toBe(AIR)
    expect(store.getLight(0, 999, 0)).toBe(FULL_SKY)
  })

  it('allocates a slot on the first non-uniform write and holds the seqlock odd until commit', () => {
    const { store, pages } = makeStore([64, 64, 64])
    expect(store.setVoxel(1, 1, 1, ID.stone)).toBe(true)
    expect(store.slotOf(0)).toBeGreaterThanOrEqual(0)
    expect(pages).toEqual([0])
    expect(store.versions[0]! & 1).toBe(1)
    expect(store.getVoxel(1, 1, 1)).toBe(ID.stone)
    expect(store.getVoxel(2, 1, 1)).toBe(AIR)
    expect(store.commit()).toEqual([0])
    expect(store.versions[0]).toBe(2)
  })

  it('ignores writes that change nothing and writes out of bounds', () => {
    const { store } = makeStore([64, 64, 64])
    expect(store.setVoxel(1, 1, 1, AIR)).toBe(false)
    expect(store.setVoxel(64, 0, 0, ID.stone)).toBe(false)
    store.setLight(1, 1, 1, FULL_SKY)
    expect(store.commit()).toEqual([])
    expect(store.versions[0]).toBe(0)
  })

  it('collapses a chunk back to uniform on commit and reuses the slot', () => {
    const { store } = makeStore([64, 64, 64])
    store.setVoxel(1, 1, 1, ID.stone)
    store.commit()
    store.setVoxel(1, 1, 1, AIR)
    store.commit()
    expect(store.slotOf(0)).toBe(-1)
    expect(store.slotsUsed()).toBe(0)
    store.setVoxel(40, 1, 1, ID.stone) // chunk 1 reuses the freed slot
    expect(store.slotsUsed()).toBe(1)
  })

  it('stores dense uniform chunks without a slot, with implied light', () => {
    const { store } = makeStore([64, 64, 64])
    store.writeChunkDense(0, new Uint16Array(32768).fill(ID.stone))
    expect(store.slotOf(0)).toBe(-1)
    expect(store.getVoxel(5, 5, 5)).toBe(ID.stone)
    expect(store.getLight(5, 5, 5)).toBe(0)
    expect(store.commit()).toEqual([0])
  })

  it('stores dense mixed chunks in a slot with per-voxel implied light', () => {
    const { store } = makeStore([64, 64, 64])
    const data = new Uint16Array(32768).fill(ID.stone)
    data[0] = ID.glass
    store.writeChunkDense(0, data)
    expect(store.getVoxel(0, 0, 0)).toBe(ID.glass)
    expect(store.getLight(0, 0, 0)).toBe(FULL_SKY)
    expect(store.getLight(1, 0, 0)).toBe(0)
  })

  it("a slot carved from a uniform chunk inherits that chunk's implied light", () => {
    const { store } = makeStore([64, 64, 64])
    store.writeChunkDense(0, new Uint16Array(32768).fill(ID.stone))
    store.commit()
    store.setVoxel(3, 3, 3, AIR)
    expect(store.getLight(4, 4, 4)).toBe(0)
  })

  it('collapses a chunk only when light matches the implied value too', () => {
    const { store } = makeStore([64, 64, 64])
    store.setLight(2, 2, 2, 0) // dark air: breaks uniformity through light alone
    store.commit()
    expect(store.slotOf(0)).toBeGreaterThanOrEqual(0)
    store.setLight(2, 2, 2, FULL_SKY)
    store.commit()
    expect(store.slotOf(0)).toBe(-1)
  })

  it('grows by pages of 256 slots', () => {
    const { store, pages } = makeStore([512, 64, 512]) // 16*2*16 = 512 chunks
    for (let ci = 0; ci < 300; ci++) {
      const [cx, cy, cz] = store.layout.chunkCoords(ci)
      store.setVoxel(cx * 32, cy * 32, cz * 32, ID.stone)
    }
    expect(pages).toEqual([0, 1])
    expect(store.slotsUsed()).toBe(300)
  })

  it('throws WorldFullError past maxPages', () => {
    const { store } = makeStore([512, 64, 512], 1)
    expect(() => {
      for (let ci = 0; ci < 257; ci++) {
        const [cx, cy, cz] = store.layout.chunkCoords(ci)
        store.setVoxel(cx * 32, cy * 32, cz * 32, ID.stone)
      }
    }).toThrow(WorldFullError)
  })

  it('reports border neighbours (including diagonals) as dirty', () => {
    const { store } = makeStore([64, 64, 64])
    store.setVoxel(31, 5, 5, ID.stone)
    expect(store.commit()).toEqual([0, 1])
    store.setVoxel(31, 31, 31, ID.stone)
    expect(store.commit()).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })
})
