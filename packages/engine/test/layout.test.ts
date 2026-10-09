import { describe, expect, it } from 'vitest'
import { CHUNK_VOLUME, Layout } from '../src/world/layout.ts'

describe('Layout', () => {
  const L = new Layout([1024, 128, 1024])
  it('computes the chunk grid of the full world', () => {
    expect([L.cx, L.cy, L.cz]).toEqual([32, 4, 32])
    expect(L.chunkCount).toBe(4096)
    expect(L.voxelCount).toBe(1024 * 128 * 1024)
    expect(CHUNK_VOLUME).toBe(32768)
  })
  it('uses the spec chunk index formula', () => {
    expect(L.chunkIndex(0, 0, 0)).toBe(0)
    expect(L.chunkIndex(31, 0, 0)).toBe(31)
    expect(L.chunkIndex(0, 0, 1)).toBe(32)
    expect(L.chunkIndex(0, 1, 0)).toBe(1024)
    expect(L.chunkIndex(31, 3, 31)).toBe(4095)
    expect(L.chunkCoords(4095)).toEqual([31, 3, 31])
  })
  it('maps voxels to chunks and local indices', () => {
    expect(L.chunkOf(33, 0, 0)).toBe(1)
    expect(L.chunkOf(0, 127, 0)).toBe(3 * 1024)
    expect(Layout.localIndex(1, 0, 0)).toBe(1)
    expect(Layout.localIndex(0, 0, 1)).toBe(32)
    expect(Layout.localIndex(0, 1, 0)).toBe(1024)
    expect(Layout.localIndex(31, 31, 31)).toBe(32767)
  })
  it('checks bounds at every edge', () => {
    expect(L.inBounds(0, 0, 0)).toBe(true)
    expect(L.inBounds(1023, 127, 1023)).toBe(true)
    expect(L.inBounds(1024, 0, 0)).toBe(false)
    expect(L.inBounds(0, 128, 0)).toBe(false)
    expect(L.inBounds(-1, 0, 0)).toBe(false)
    expect(L.inBounds(0.5, 0, 0)).toBe(false)
  })
  it('round-trips packed voxel positions', () => {
    const i = L.voxelIndex(1023, 127, 1023)
    expect(i).toBe(L.voxelCount - 1)
    expect(L.voxelCoords(i)).toEqual([1023, 127, 1023])
    expect(L.voxelCoords(L.voxelIndex(5, 6, 7))).toEqual([5, 6, 7])
  })
  it('lists the chunks around a voxel, sorted and clipped to the world', () => {
    expect(L.chunksAround(5, 6, 7)).toEqual([L.chunkOf(5, 6, 7)])
    expect(L.chunksAround(31, 32, 64)).toEqual([L.chunkIndex(0, 0, 1), L.chunkIndex(0, 0, 2), L.chunkIndex(1, 0, 1), L.chunkIndex(1, 0, 2), L.chunkIndex(0, 1, 1), L.chunkIndex(0, 1, 2), L.chunkIndex(1, 1, 1), L.chunkIndex(1, 1, 2)].sort((a, b) => a - b))
    expect(L.chunksAround(0, 0, 1023)).toEqual([L.chunkIndex(0, 0, 31)])
  })
  it('rejects sizes that are not positive multiples of 32', () => {
    expect(() => new Layout([100, 128, 128])).toThrow(RangeError)
    expect(() => new Layout([0, 32, 32])).toThrow(RangeError)
  })
})
