import { describe, expect, it } from 'vitest'
import { raycast } from '../src/interact/raycast.ts'

const SIZE = [64, 64, 64] as const
function world(blocks: [number, number, number, number][]) {
  const m = new Map(blocks.map(([x, y, z, v]) => [`${x},${y},${z}`, v]))
  return (x: number, y: number, z: number) => m.get(`${x},${y},${z}`) ?? 0
}
const solid = (v: number) => v !== 0 && v !== 5 // 5 = water, not pickable

describe('raycast', () => {
  it('hits along an axis and reports the entry face', () => {
    const hit = raycast(world([[5, 10, 0, 1]]), solid, SIZE, [0.5, 10.5, 0.5], [1, 0, 0], 64)
    expect(hit).toEqual({ pos: [5, 10, 0], normal: [-1, 0, 0], voxel: 1, distance: 4.5 })
  })
  it('hits diagonally', () => {
    const hit = raycast(world([[3, 3, 3, 1]]), solid, SIZE, [0.5, 0.5, 0.5], [1, 1, 1], 64)!
    expect(hit.pos).toEqual([3, 3, 3])
    expect(hit.distance).toBeCloseTo(2.5 * Math.sqrt(3), 5)
    expect(Math.abs(hit.normal[0]) + Math.abs(hit.normal[1]) + Math.abs(hit.normal[2])).toBe(1)
  })
  it('crosses chunk borders', () => {
    const hit = raycast(world([[32, 10, 0, 1]]), solid, SIZE, [30.5, 10.5, 0.5], [1, 0, 0], 64)
    expect(hit?.pos).toEqual([32, 10, 0])
  })
  it('hits at distance 0 when starting inside a block', () => {
    const hit = raycast(world([[2, 2, 2, 1]]), solid, SIZE, [2.5, 2.5, 2.5], [0, 1, 0], 64)
    expect(hit).toEqual({ pos: [2, 2, 2], normal: [0, 0, 0], voxel: 1, distance: 0 })
  })
  it('enters the world from outside', () => {
    const side = raycast(world([[0, 10, 0, 1]]), solid, SIZE, [-5, 10.5, 0.5], [1, 0, 0], 64)
    expect(side).toEqual({ pos: [0, 10, 0], normal: [-1, 0, 0], voxel: 1, distance: 5 })
    const top = world([[10, 3, 10, 1]])
    expect(raycast(top, solid, SIZE, [10.5, 100, 10.5], [0, -1, 0], 64)).toBeNull()
    expect(raycast(top, solid, SIZE, [10.5, 100, 10.5], [0, -1, 0], 200)).toEqual({ pos: [10, 3, 10], normal: [0, 1, 0], voxel: 1, distance: 96 })
  })
  it('returns null for misses, max distance and zero directions', () => {
    const w = world([[20, 10, 0, 1]])
    expect(raycast(w, solid, SIZE, [-5, 100, -5], [1, 0, 0], 500)).toBeNull()
    expect(raycast(w, solid, SIZE, [0.5, 10.5, 0.5], [1, 0, 0], 10)).toBeNull()
    expect(raycast(w, solid, SIZE, [0.5, 10.5, 0.5], [0, 0, 0], 10)).toBeNull()
  })
  it('skips voxels that are not pickable', () => {
    const hit = raycast(world([[3, 1, 0, 5], [6, 1, 0, 1]]), solid, SIZE, [0.5, 1.5, 0.5], [1, 0, 0], 64)
    expect(hit?.pos).toEqual([6, 1, 0])
  })
  it('accepts object vectors', () => {
    const hit = raycast(world([[5, 10, 0, 1]]), solid, SIZE, { x: 0.5, y: 10.5, z: 0.5 }, { x: 2, y: 0, z: 0 }, 64)
    expect(hit?.distance).toBe(4.5)
  })
  it('returns null for NaN direction component', () => {
    const hit = raycast(world([[5, 10, 0, 1]]), solid, SIZE, [0.5, 10.5, 0.5], [NaN, 0, 0], 64)
    expect(hit).toBeNull()
  }, 1000)
  it('returns null for NaN origin component', () => {
    const hit = raycast(world([[5, 10, 0, 1]]), solid, SIZE, [NaN, 10.5, 0.5], [1, 0, 0], 64)
    expect(hit).toBeNull()
  })
  it('returns null for NaN or negative maxDist', () => {
    const w = world([[5, 10, 0, 1]])
    expect(raycast(w, solid, SIZE, [0.5, 10.5, 0.5], [1, 0, 0], NaN)).toBeNull()
    expect(raycast(w, solid, SIZE, [0.5, 10.5, 0.5], [1, 0, 0], -10)).toBeNull()
  })
  it('accepts an infinite maxDist: hits a block and still stops at the world edge on a miss', () => {
    const w = world([[40, 10, 0, 1]])
    expect(raycast(w, solid, SIZE, [0.5, 10.5, 0.5], [1, 0, 0], Infinity)?.pos).toEqual([40, 10, 0])
    expect(raycast(w, solid, SIZE, [0.5, 20.5, 0.5], [1, 0, 0], Infinity)).toBeNull()
  })
})
