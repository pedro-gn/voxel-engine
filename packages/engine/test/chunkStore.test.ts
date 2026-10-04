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

  it('reports a chunk open from its first write until commit, and a dirty-marked one as closed', () => {
    const { store } = makeStore([64, 64, 64])
    store.setLight(1, 1, 1, 3)
    store.markDirty(1)
    expect(store.isOpen(0)).toBe(true)
    expect(store.isOpen(1)).toBe(false)
    store.commit()
    expect(store.isOpen(0)).toBe(false)
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

  it('reads a uniform chunk into the scratch array and a slot chunk from its slot', () => {
    const { store } = makeStore([64, 64, 64])
    const vox = new Uint16Array(32768), light = new Uint8Array(32768)
    expect(store.readVoxels(0, vox)).toBe(vox)
    expect(vox.every((v) => v === AIR)).toBe(true)
    expect(store.readLight(0, light).every((l) => l === FULL_SKY)).toBe(true)
    expect(store.lightSnapshot(0)).toBe(FULL_SKY)
    store.setVoxel(1, 1, 1, ID.stone)
    store.commit()
    const slotVox = store.readVoxels(0, vox)
    expect(slotVox).not.toBe(vox)
    expect(slotVox[1 + (1 << 5) + (1 << 10)]).toBe(ID.stone)
    const snap = store.lightSnapshot(0)
    expect(snap).toBeInstanceOf(Uint8Array)
    expect(snap).not.toBe(store.readLight(0, light)) // a copy, not the live slot
  })

  it('gives the implied light of an opaque uniform chunk', () => {
    const { store } = makeStore([64, 64, 64])
    store.writeChunkDense(0, new Uint16Array(32768).fill(ID.stone))
    store.commit()
    expect(store.lightSnapshot(0)).toBe(0)
    expect(store.readLight(0, new Uint8Array(32768)).every((l) => l === 0)).toBe(true)
  })
  it('writes quietly: the version moves but commit() asks for no remesh', () => {
    const { store } = makeStore([64, 64, 64])
    expect(store.setVoxelQuiet(1, 1, 1, ID.water)).toBe(true)
    expect(store.versions[0]! & 1).toBe(1)
    expect(store.getVoxel(1, 1, 1)).toBe(ID.water)
    expect(store.commit()).toEqual([])
    expect(store.versions[0]).toBe(2)
    expect(store.setVoxelQuiet(1, 1, 1, ID.water)).toBe(false)
  })

  it('remeshes a chunk that a normal write also opened, whichever came first', () => {
    const { store } = makeStore([64, 64, 64])
    store.setVoxelQuiet(1, 1, 1, ID.water)
    store.setVoxel(2, 1, 1, ID.stone)
    expect(store.commit()).toEqual([0])
    store.setVoxel(3, 1, 1, ID.stone)
    store.setVoxelQuiet(4, 1, 1, ID.water)
    expect(store.commit()).toEqual([0])
    store.setVoxelQuiet(5, 1, 1, ID.water)
    expect(store.commit()).toEqual([]) // the quiet mark does not leak into the next commit
  })

  it('gives a uniform chunk a slot for a quiet write and collapses it once it is uniform again', () => {
    const { store } = makeStore([64, 64, 64])
    store.writeChunkDense(0, new Uint16Array(32768).fill(ID.water))
    store.commit()
    expect(store.slotOf(0)).toBe(-1)
    store.setVoxelQuiet(1, 31, 1, AIR)
    store.commit()
    expect(store.slotOf(0)).toBeGreaterThanOrEqual(0)
    store.setVoxelQuiet(1, 31, 1, ID.water)
    store.commit()
    expect(store.slotOf(0)).toBe(-1)
  })
})
