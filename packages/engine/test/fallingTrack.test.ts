import { describe, expect, it } from 'vitest'
import { FallingTrack } from '../src/render/fallingTrack.ts'

const body = (id: number, y256: number, vy256 = 24) => ({ id, voxel: 8, x: 3, z: 4, y256, vy256 })

describe('FallingTrack', () => {
  it('starts a new body at its old cell and interpolates over one tick', () => {
    const t = new FallingTrack()
    t.update([body(1, 2560 - 24)], [], 1000)
    expect(t.frame(1000, 50, () => -1)).toEqual([{ voxel: 8, x: 3, y: 10, z: 4 }])
    expect(t.frame(1025, 50, () => -1)[0]!.y).toBeCloseTo((2560 - 12) / 256, 6)
    t.update([body(1, 2560 - 72, 48)], [], 1050)
    expect(t.frame(1050, 50, () => -1)[0]!.y).toBeCloseTo((2560 - 24) / 256, 6)
  })
  it('keeps a landed body until the mesh of its chunk at the landing version is applied', () => {
    const t = new FallingTrack()
    t.update([body(1, 300)], [], 0)
    t.update([], [{ id: 1, x: 3, y: 1, z: 4, chunk: 7, version: 12 }], 50)
    let applied = 10
    expect(t.frame(100, 50, () => applied)).toEqual([{ voxel: 8, x: 3, y: 1, z: 4 }])
    t.update([], [], 100) // later ticks hold it still
    expect(t.frame(120, 50, () => applied)[0]!.y).toBe(1)
    applied = 12
    expect(t.frame(140, 50, () => applied)).toEqual([])
    expect(t.size).toBe(0)
  })
  it('forgets a body that disappears without landing', () => {
    const t = new FallingTrack()
    t.update([body(1, 300)], [], 0)
    t.update([], [], 50)
    expect(t.size).toBe(0)
  })
})
