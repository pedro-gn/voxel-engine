import { describe, expect, it } from 'vitest'
import { ChunkStore } from '../src/world/chunkStore.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { CHUNK_VOLUME, Layout } from '../src/world/layout.ts'
import { decodeRegion, encodeRegion, regionGrid, regionOfChunk } from '../src/persist/regions.ts'

const opaque = new Uint8Array(16).fill(1); opaque[0] = 0
const store = (size: [number, number, number]) => new ChunkStore({ buffers: createWorldBuffers(size), opaque })

describe('save regions', () => {
  it('tiles the world in 8 × 8 chunk columns, clipping the last row', () => {
    const L = new Layout([320, 64, 256])
    expect(regionGrid(L)).toEqual({ rx: 2, rz: 1, count: 2 })
    expect(regionOfChunk(L, L.chunkIndex(7, 1, 7))).toBe(0)
    expect(regionOfChunk(L, L.chunkIndex(8, 0, 0))).toBe(1)
  })
  it('round-trips uniform and dense chunks, state bits included', () => {
    const s = store([256, 64, 256])
    s.setVoxel(3, 40, 5, 2 | (5 << 12)); s.setVoxel(200, 1, 200, 7)
    s.commit()
    const got = new Map<number, Uint16Array | number>()
    decodeRegion(encodeRegion(s, 0), s.layout, 0, (ci, d) => got.set(ci, typeof d === 'number' ? d : d.slice()))
    expect(got.size).toBe(8 * 8 * 2)
    const dense = got.get(s.layout.chunkOf(3, 40, 5)) as Uint16Array
    expect(dense.length).toBe(CHUNK_VOLUME)
    expect(dense[Layout.localIndex(3, 40 & 31, 5)]).toBe(2 | (5 << 12))
    expect(got.get(s.layout.chunkIndex(4, 0, 4))).toBe(0)
  })
  it('bumps the region revision on every kind of write, and only that region', () => {
    const s = store([512, 32, 256])
    const before = s.regionRevisions.slice()
    s.setVoxel(300, 1, 10, 1); s.commit()
    expect(s.regionRevisions[1]).toBeGreaterThan(before[1]!)
    expect(s.regionRevisions[0]).toBe(before[0])
    s.setVoxelQuiet(10, 1, 10, 3); s.commit()
    expect(s.regionRevisions[0]).toBeGreaterThan(before[0]!)
  })
  it('refuses another format version and a region of another size', () => {
    const s = store([256, 32, 256])
    const b = encodeRegion(s, 0); b[4] = 99
    expect(() => decodeRegion(b, s.layout, 0, () => {})).toThrow(/region format 99/)
    expect(() => decodeRegion(encodeRegion(s, 0), new Layout([256, 64, 256]), 0, () => {})).toThrow(/holds 64 chunks/)
  })
})
