import { describe, expect, it } from 'vitest'
import { LightEngine } from '../src/sim/light.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ChunkStore } from '../src/world/chunkStore.ts'
import { AIR, blockLight, skyLight } from '../src/world/voxel.ts'
import { ID, testRegistry } from './helpers.ts'

const reg = testRegistry()
function world(size: [number, number, number] = [64, 64, 64]) {
  const store = new ChunkStore({ buffers: createWorldBuffers(size), opaque: reg.opaque })
  const light = new LightEngine(store, { opaque: reg.opaque, emits: reg.emits })
  const edit = (x: number, y: number, z: number, v: number) => {
    const old = store.getVoxel(x, y, z)
    if (store.setVoxel(x, y, z, v)) light.onVoxelChanged(x, y, z, old, v)
  }
  const sky = (x: number, y: number, z: number) => skyLight(store.getLight(x, y, z))
  const blk = (x: number, y: number, z: number) => blockLight(store.getLight(x, y, z))
  return { store, light, edit, sky, blk }
}
function roof(store: ChunkStore, y: number, hole?: [number, number]) {
  for (let x = 0; x < 64; x++) for (let z = 0; z < 64; z++) {
    if (hole && hole[0] === x && hole[1] === z) continue
    store.setVoxel(x, y, z, ID.stone)
  }
}

describe('LightEngine.initialize', () => {
  it('lights open sky fully', () => {
    const w = world()
    w.light.initialize()
    expect(w.sky(5, 5, 5)).toBe(15)
  })
  it('darkens everything under a closed roof', () => {
    const w = world()
    roof(w.store, 40)
    w.light.initialize()
    expect(w.sky(10, 41, 10)).toBe(15)
    expect(w.sky(10, 20, 10)).toBe(0)
  })
  it('lets sky fall straight through a hole and fall off sideways', () => {
    const w = world()
    roof(w.store, 40, [32, 32])
    w.light.initialize()
    expect(w.sky(32, 20, 32)).toBe(15)
    expect(w.sky(35, 39, 32)).toBe(12)
  })
  it('spreads block light from emitters', () => {
    const w = world()
    roof(w.store, 40)
    w.store.setVoxel(10, 20, 10, ID.torch)
    w.light.initialize()
    expect(w.blk(10, 20, 10)).toBe(14)
    expect(w.blk(13, 20, 10)).toBe(11)
    expect(w.sky(13, 20, 10)).toBe(0)
  })
  it('darkens an enclosed uniform air chunk, giving it a slot', () => {
    const w = world([64, 96, 64])
    const L = w.store.layout
    for (let cz = 0; cz < 2; cz++) for (let cx = 0; cx < 2; cx++) {
      w.store.writeChunkDense(L.chunkIndex(cx, 2, cz), new Uint16Array(32768).fill(ID.stone))
    }
    w.light.initialize()
    expect(w.sky(5, 5, 5)).toBe(0)
    expect(w.store.slotOf(0)).toBeGreaterThanOrEqual(0)
  })
})

describe('LightEngine incremental updates', () => {
  it('places and removes a torch', () => {
    const w = world()
    roof(w.store, 40)
    w.light.initialize()
    w.edit(10, 20, 10, ID.torch)
    w.light.propagate()
    expect(w.blk(10, 20, 10)).toBe(14)
    expect(w.blk(13, 20, 10)).toBe(11)
    w.edit(10, 20, 10, AIR)
    w.light.propagate()
    expect(w.blk(10, 20, 10)).toBe(0)
    expect(w.blk(13, 20, 10)).toBe(0)
  })
  it('opens and closes a skylight shaft', () => {
    const w = world()
    roof(w.store, 40)
    w.light.initialize()
    w.edit(20, 40, 20, AIR)
    w.light.propagate()
    expect(w.sky(20, 10, 20)).toBe(15)
    expect(w.sky(22, 10, 20)).toBe(13)
    w.edit(20, 40, 20, ID.stone)
    w.light.propagate()
    expect(w.sky(20, 10, 20)).toBe(0)
    expect(w.sky(22, 10, 20)).toBe(0)
  })
  it('is blocked by opaque walls', () => {
    const w = world()
    roof(w.store, 40)
    for (let y = 0; y < 40; y++) for (let z = 0; z < 64; z++) w.store.setVoxel(12, y, z, ID.stone)
    w.light.initialize()
    w.edit(10, 20, 10, ID.torch)
    w.light.propagate()
    expect(w.blk(11, 20, 10)).toBe(13)
    expect(w.blk(13, 20, 10)).toBe(0)
  })
  it('relights the top layer when a block there is removed', () => {
    const w = world()
    w.light.initialize()
    w.edit(3, 63, 3, ID.stone)
    w.light.propagate()
    expect(w.sky(3, 62, 3)).toBe(14) // lit sideways from neighbours now
    w.edit(3, 63, 3, AIR)
    w.light.propagate()
    expect(w.sky(3, 63, 3)).toBe(15)
    expect(w.sky(3, 62, 3)).toBe(15)
  })
})
