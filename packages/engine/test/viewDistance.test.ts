import { describe, expect, it } from 'vitest'
import { DEFAULT_CAMERA_FAR, boxDistanceSq, boxInRange, cameraFar, chunkInRange, edgeBand } from '../src/render/viewDistance.ts'

describe('viewDistance helpers', () => {
  it('measures the distance to a box\'s nearest point, 0 inside', () => {
    expect(boxDistanceSq(5, 5, 5, 0, 0, 0, 10, 10, 10)).toBe(0)
    expect(boxDistanceSq(13, 5, 5, 0, 0, 0, 10, 10, 10)).toBe(9)
    expect(boxDistanceSq(13, 14, 5, 0, 0, 0, 10, 10, 10)).toBe(9 + 16)
    expect(boxDistanceSq(-3, -4, 5, 0, 0, 0, 10, 10, 10)).toBe(25)
  })
  it('keeps everything at Infinity, and a box exactly at range', () => {
    expect(boxInRange({ x: 1e9, y: 0, z: 0 }, Infinity, 0, 0, 0, 1, 1, 1)).toBe(true)
    expect(boxInRange({ x: 20, y: 0, z: 0 }, 10, 0, 0, 0, 10, 10, 10)).toBe(true)
    expect(boxInRange({ x: 20.01, y: 0, z: 0 }, 10, 0, 0, 0, 10, 10, 10)).toBe(false)
  })
  it('tests a chunk by its 32³ box around its centre, also with the eye below or above the world', () => {
    expect(chunkInRange({ x: 16, y: -50, z: 16 }, 50, 16, 16, 16)).toBe(true) // 50 below the box bottom at y 0
    expect(chunkInRange({ x: 16, y: -51, z: 16 }, 50, 16, 16, 16)).toBe(false)
    expect(chunkInRange({ x: 100, y: 16, z: 16 }, 68, 16, 16, 16)).toBe(true) // x face at 32
  })
  it('ties the far plane to R plus a chunk diagonal, 3000 at Infinity', () => {
    expect(cameraFar(Infinity)).toBe(DEFAULT_CAMERA_FAR)
    expect(cameraFar(256)).toBe(320)
  })
  it('puts the edge band at [0.75 R, R], and out of reach at Infinity', () => {
    expect(edgeBand(400)).toEqual([300, 400])
    const [n, f] = edgeBand(Infinity)
    expect(n).toBeGreaterThan(1e29)
    expect(f).toBeGreaterThan(n) // smoothstep(n, f, d) is 0 for every real distance, never NaN
  })
})
