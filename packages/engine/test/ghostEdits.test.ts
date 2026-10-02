import { describe, expect, it } from 'vitest'
import { GhostEdits, chunksTouching } from '../src/interact/ghostEdits.ts'
import { raycast } from '../src/interact/raycast.ts'
import { Layout } from '../src/world/layout.ts'

const L = new Layout([64, 64, 64])

describe('chunksTouching', () => {
  it('includes border neighbours and diagonals', () => {
    expect(chunksTouching(L, 5, 5, 5)).toEqual([0])
    expect(chunksTouching(L, 31, 5, 5)).toEqual([0, 1])
    expect(chunksTouching(L, 31, 31, 31)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(chunksTouching(L, 0, 0, 0)).toEqual([0]) // world edge: no out-of-bounds chunks
  })
})

describe('GhostEdits', () => {
  it('overlays predicted voxels until resolved', () => {
    const g = new GhostEdits(L)
    expect(g.add(1, 31, 5, 5, 3)).toEqual([0, 1])
    expect(g.get(31, 5, 5)).toBe(3)
    expect(g.resolve(1)).toEqual([0, 1])
    expect(g.get(31, 5, 5)).toBeUndefined()
    expect(g.size).toBe(0)
  })
  it('keeps the newest ghost when an older seq resolves (spam-click)', () => {
    const g = new GhostEdits(L)
    g.add(1, 5, 5, 5, 3) // place
    g.add(2, 5, 5, 5, 0) // remove before ack 1 arrives
    expect(g.get(5, 5, 5)).toBe(0)
    g.resolve(1)
    expect(g.get(5, 5, 5)).toBe(0)
    g.resolve(2)
    expect(g.get(5, 5, 5)).toBeUndefined()
  })
  it('lists overrides for a chunk, including ghosts in its 1-voxel border', () => {
    const g = new GhostEdits(L)
    g.add(1, 32, 5, 5, 3) // inside chunk 1, on chunk 0's border
    g.add(2, 50, 5, 5, 3) // inside chunk 1, far from chunk 0
    expect(g.overridesFor(0)).toEqual([[32, 5, 5, 3]])
    expect(g.overridesFor(1)).toHaveLength(2)
  })
  it('feeds the raycast through an overlay getter', () => {
    const g = new GhostEdits(L)
    g.add(1, 5, 10, 0, 1)
    const get = (x: number, y: number, z: number) => g.get(x, y, z) ?? 0
    expect(raycast(get, (v) => v !== 0, L.size, [0.5, 10.5, 0.5], [1, 0, 0], 64)?.pos).toEqual([5, 10, 0])
  })
  it('ray passes through a ghost-deleted world voxel and stops at the next solid one', () => {
    const g = new GhostEdits(L)
    const world = (x: number, y: number, z: number) => (y === 10 && z === 0 && (x === 5 || x === 8) ? 1 : 0)
    const get = (x: number, y: number, z: number) => g.get(x, y, z) ?? world(x, y, z)
    const cast = () => raycast(get, (v) => v !== 0, L.size, [0.5, 10.5, 0.5], [1, 0, 0], 64)?.pos
    expect(cast()).toEqual([5, 10, 0])
    g.add(1, 5, 10, 0, 0) // predicted removal
    expect(cast()).toEqual([8, 10, 0])
  })
})
