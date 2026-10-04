import { describe, expect, it } from 'vitest'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ChunkStore } from '../src/world/chunkStore.ts'
import { OUTSIDE, WorldReader, createSnapshot, padIndex } from '../src/world/reader.ts'
import { AIR, FULL_SKY } from '../src/world/voxel.ts'
import { ID, testRegistry } from './helpers.ts'

const reg = testRegistry()
function pair(size: [number, number, number] = [64, 64, 64], sharePages = true) {
  const buffers = createWorldBuffers(size)
  const reader = new WorldReader(buffers, reg.opaque)
  const store = new ChunkStore({
    buffers, opaque: reg.opaque,
    onNewPage: (i, p) => { if (sharePages) reader.addPage(i, p) },
  })
  return { store, reader }
}

describe('WorldReader', () => {
  it('reads what the store wrote', () => {
    const { store, reader } = pair()
    store.setVoxel(10, 20, 30, ID.stone)
    store.commit()
    expect(reader.get(10, 20, 30)).toBe(ID.stone)
    expect(reader.get(11, 20, 30)).toBe(AIR)
    expect(reader.get(-1, 0, 0)).toBe(AIR)
    expect(reader.getLight(-1, 0, 0)).toBe(FULL_SKY)
  })

  it('treats a slot on a page it has not received yet as air, and refuses to snapshot it', () => {
    const { store, reader } = pair([64, 64, 64], false)
    store.setVoxel(1, 1, 1, ID.stone)
    store.commit()
    expect(reader.get(1, 1, 1)).toBe(AIR)
    expect(reader.getLight(1, 1, 1)).toBe(FULL_SKY)
    expect(reader.snapshot(0, createSnapshot())).toBeNull()
  })

  it('copies a chunk with a 1-voxel border from face and diagonal neighbours', () => {
    const { store, reader } = pair()
    store.setVoxel(32, 0, 0, ID.stone)  // chunk 1, face neighbour of chunk 0
    store.setVoxel(32, 32, 32, ID.dirt) // diagonal neighbour of chunk 0
    store.setVoxel(5, 6, 7, ID.glass)   // inside chunk 0
    store.commit()
    const snap = createSnapshot()
    expect(reader.snapshot(0, snap)).not.toBeNull()
    expect(snap.voxels[padIndex(33, 1, 1)]).toBe(ID.stone)
    expect(snap.voxels[padIndex(33, 33, 33)]).toBe(ID.dirt)
    expect(snap.voxels[padIndex(6, 7, 8)]).toBe(ID.glass)
    expect(snap.voxels[padIndex(0, 1, 1)]).toBe(AIR)      // x = -1: outside the world
    expect(snap.light[padIndex(0, 1, 1)]).toBe(FULL_SKY)
  })

  it('marks the sides of a snapshot whose border lies outside the world (x and z)', () => {
    const { reader } = pair([96, 64, 64])
    const L = reader.layout
    const outside = (cx: number, cz: number) => {
      const snap = createSnapshot()
      snap.outside = -1 // stale value from a previous chunk
      expect(reader.snapshot(L.chunkIndex(cx, 0, cz), snap)).not.toBeNull()
      return snap.outside
    }
    expect(outside(0, 0)).toBe(OUTSIDE.NX | OUTSIDE.NZ)
    expect(outside(1, 0)).toBe(OUTSIDE.NZ)
    expect(outside(2, 1)).toBe(OUTSIDE.PX | OUTSIDE.PZ)
  })

  it('copies uniform neighbours with their implied light', () => {
    const { store, reader } = pair()
    store.writeChunkDense(1, new Uint16Array(32768).fill(ID.stone))
    store.commit()
    const snap = createSnapshot()
    reader.snapshot(0, snap)
    expect(snap.voxels[padIndex(33, 5, 5)]).toBe(ID.stone)
    expect(snap.light[padIndex(33, 5, 5)]).toBe(0)
  })

  it('returns null while a writer holds the chunk, and the version once it commits', () => {
    const { store, reader } = pair()
    store.setVoxel(1, 1, 1, ID.stone)
    expect(reader.snapshot(0, createSnapshot())).toBeNull()
    store.commit()
    expect(reader.snapshot(0, createSnapshot())).toBe(2)
  })

  it('returns null when a neighbour is being written', () => {
    const { store, reader } = pair()
    store.setVoxel(40, 1, 1, ID.stone) // chunk 1 open
    expect(reader.snapshot(0, createSnapshot())).toBeNull()
  })

  it('identifies trivially empty chunks', () => {
    const { store, reader } = pair([96, 96, 96])
    expect(reader.isTrivial(0)).toBe(true) // uniform air
    const L = store.layout
    for (let ci = 0; ci < L.chunkCount; ci++) store.writeChunkDense(ci, new Uint16Array(32768).fill(ID.stone))
    store.commit()
    const centre = L.chunkIndex(1, 1, 1)
    expect(reader.isTrivial(centre)).toBe(true)  // enclosed solid
    expect(reader.isTrivial(0)).toBe(false)      // world-edge faces are visible
    store.setVoxel(64, 40, 40, ID.glass)         // chunk (2,1,1) no longer uniform opaque
    store.commit()
    expect(reader.isTrivial(centre)).toBe(false)
  })
})
