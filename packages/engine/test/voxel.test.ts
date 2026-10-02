import { describe, expect, it } from 'vitest'
import {
  AIR, FULL_SKY, blockLight, packLight, packVoxel, skyLight, voxelId, voxelState, withState,
} from '../src/world/voxel.ts'

describe('voxel packing', () => {
  it('round-trips id and state', () => {
    for (const [id, s] of [[0, 0], [1, 0], [4095, 15], [77, 9]] as const) {
      const v = packVoxel(id, s)
      expect(voxelId(v)).toBe(id)
      expect(voxelState(v)).toBe(s)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(0xffff)
    }
  })
  it('air is zero', () => expect(AIR).toBe(0))
  it('withState replaces only state', () => {
    const v = withState(packVoxel(12, 3), 7)
    expect(voxelId(v)).toBe(12)
    expect(voxelState(v)).toBe(7)
  })
  it('rejects out-of-range ids and states', () => {
    expect(() => packVoxel(4096)).toThrow(RangeError)
    expect(() => packVoxel(-1)).toThrow(RangeError)
    expect(() => packVoxel(1, 16)).toThrow(RangeError)
  })
  it('round-trips light', () => {
    const l = packLight(13, 6)
    expect(skyLight(l)).toBe(13)
    expect(blockLight(l)).toBe(6)
    expect(FULL_SKY).toBe(15)
  })
})
