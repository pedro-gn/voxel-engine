import { describe, expect, it } from 'vitest'
import { columnTop, ghostAwareGet, markTick } from '../src/engineWorld.ts'
import { GhostEdits } from '../src/interact/ghostEdits.ts'
import { raycast } from '../src/interact/raycast.ts'
import { MeshQueue, PRIORITY } from '../src/render/meshQueue.ts'
import { createWorldBuffers, encodeUniform } from '../src/world/buffers.ts'
import { Layout } from '../src/world/layout.ts'
import { WorldReader } from '../src/world/reader.ts'
import { ID, testRegistry } from './helpers.ts'

const SIZE = [64, 64, 64] as const
const L = new Layout(SIZE)
const reg = testRegistry()

function emptyWorld() {
  const reader = new WorldReader(createWorldBuffers(SIZE), reg.opaque)
  const ghosts = new GhostEdits(L)
  return { reader, ghosts, get: ghostAwareGet(ghosts, (x, y, z) => reader.get(x, y, z)) }
}
const pickable = (v: number) => v !== 0

describe('ghostAwareGet', () => {
  it('lets a ray hit a ghost voxel before the sim has written it, and stops once it resolves', () => {
    const { ghosts, get } = emptyWorld()
    ghosts.add(1, 10, 20, 10, ID.stone)
    expect(get(10, 20, 10)).toBe(ID.stone)
    const hit = raycast(get, pickable, SIZE, [10.5, 40.5, 10.5], [0, -1, 0], 64)
    expect(hit).toEqual({ pos: [10, 20, 10], normal: [0, 1, 0], voxel: ID.stone, distance: 19.5 })
    ghosts.resolve(1)
    expect(raycast(get, pickable, SIZE, [10.5, 40.5, 10.5], [0, -1, 0], 64)).toBeNull()
  })

  it('a ghost air voxel hides the shared-memory block under it', () => {
    const buffers = createWorldBuffers(SIZE)
    new Int32Array(buffers.chunkTable).fill(encodeUniform(ID.stone))
    const reader = new WorldReader(buffers, reg.opaque)
    const ghosts = new GhostEdits(L)
    const get = ghostAwareGet(ghosts, (x, y, z) => reader.get(x, y, z))
    ghosts.add(1, 5, 5, 5, 0)
    expect(get(5, 5, 5)).toBe(0)
    expect(get(5, 6, 5)).toBe(ID.stone)
  })
})

describe('markTick', () => {
  it('a rejected ack drops its ghost and remeshes every chunk it touched, diagonals included', () => {
    const ghosts = new GhostEdits(L)
    const queue = new MeshQueue()
    ghosts.add(7, 31, 31, 31, ID.stone)
    markTick({ acks: [{ clientId: 0, seq: 7, ok: false, error: 'nope' }], dirtyChunks: [] }, 0, ghosts, (ci, p) => queue.mark(ci, p))
    expect(ghosts.get(31, 31, 31)).toBeUndefined()
    expect(queue.size).toBe(8)
    for (let ci = 0; ci < 8; ci++) expect(queue.priorityOf(ci)).toBe(PRIORITY.GHOST)
  })

  it('marks dirty chunks too, without downgrading a ghost mark, and ignores other clients', () => {
    const ghosts = new GhostEdits(L)
    const queue = new MeshQueue()
    ghosts.add(3, 5, 5, 5, ID.stone)
    const mark = (ci: number, p: number) => queue.mark(ci, p)
    markTick({ acks: [{ clientId: 1, seq: 3, ok: true }], dirtyChunks: [] }, 0, ghosts, mark)
    expect(ghosts.get(5, 5, 5)).toBe(ID.stone) // someone else's seq 3
    markTick({ acks: [{ clientId: 0, seq: 3, ok: true }], dirtyChunks: [0, 5] }, 0, ghosts, mark)
    expect(ghosts.size).toBe(0)
    expect(queue.priorityOf(0)).toBe(PRIORITY.GHOST)
    expect(queue.priorityOf(5)).toBe(PRIORITY.DIRTY)
  })
})

describe('columnTop', () => {
  it('returns one above the highest solid voxel, clamping x/z into the world', () => {
    const { ghosts, get } = emptyWorld()
    ghosts.add(1, 0, 12, 0, ID.stone)
    ghosts.add(2, 63, 30, 63, ID.stone)
    ghosts.add(3, 63, 40, 63, ID.water) // not solid
    expect(columnTop(get, reg.solid, SIZE, 0.7, 0.2)).toBe(13)
    expect(columnTop(get, reg.solid, SIZE, -50, -3)).toBe(13)
    expect(columnTop(get, reg.solid, SIZE, 64, 1e9)).toBe(31)
    expect(columnTop(get, reg.solid, SIZE, 20, 20)).toBe(0)
  })

  it('stays finite for non-finite input', () => {
    const { get } = emptyWorld()
    for (const v of [NaN, Infinity, -Infinity]) expect(Number.isFinite(columnTop(get, reg.solid, SIZE, v, v))).toBe(true)
  })
})
