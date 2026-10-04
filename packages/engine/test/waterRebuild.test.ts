import { describe, expect, it } from 'vitest'
import { BlockRegistry, defineBlock } from '../src/blocks/registry.ts'
import { WaterColumns } from '../src/sim/water/columns.ts'
import { SUB, UNIT } from '../src/sim/water/constants.ts'
import { WaterMirror, quantize } from '../src/sim/water/mirror.ts'
import { rebuildColumns, waterKinds } from '../src/sim/water/rebuild.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ChunkStore } from '../src/world/chunkStore.ts'
import { AIR, packVoxel } from '../src/world/voxel.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'

const reg = new BlockRegistry([...TEST_BLOCKS, defineBlock({ name: 'spring', liquid: true, source: 'water', textures: 'water' })])
const kind = waterKinds(reg, ID.water)
const water = (level: number) => packVoxel(ID.water, level)

function world(fill: (x: number, y: number, z: number) => number, size: [number, number, number] = [32, 64, 32]) {
  const buffers = createWorldBuffers(size)
  const store = new ChunkStore({ buffers, opaque: reg.opaque })
  const L = store.layout, data = new Uint16Array(32768)
  for (let ci = 0; ci < L.chunkCount; ci++) {
    const [cx, cy, cz] = L.chunkCoords(ci)
    for (let i = 0; i < 32768; i++) data[i] = fill(cx * 32 + (i & 31), cy * 32 + (i >> 10), cz * 32 + ((i >> 5) & 31))
    store.writeChunkDense(ci, data)
  }
  store.commit()
  const cols = new WaterColumns(size[0], size[2], new Int16Array(buffers.water.floor))
  const mirror = new WaterMirror(cols.n)
  rebuildColumns(store, kind, cols, mirror, 0, 0, size[0], size[2])
  const at = (x: number, z: number) => ({ floor: cols.floor[x + z * size[0]]!, depth: cols.depth[x + z * size[0]]! })
  return { store, cols, mirror, at, buffers }
}

describe('rebuildColumns', () => {
  it('reads a lake (partial top cell included), a dry column and an empty one', () => {
    const { at, mirror, buffers } = world((x, y, z) => {
      if (x === 31 && z === 31) return AIR
      if (y < 3) return ID.stone
      if (x < 8 && y <= 5) return y === 5 ? water(3) : water(7)
      return AIR
    })
    expect(at(2, 2)).toEqual({ floor: 3, depth: 2 * SUB + 4 * UNIT })
    expect(mirror.q[2 + 2 * 32]).toBe(quantize(3 * SUB + 2 * SUB + 4 * UNIT)) // canonical: nothing to rewrite
    expect(at(20, 2)).toEqual({ floor: 3, depth: 0 })
    expect(at(31, 31)).toEqual({ floor: 0, depth: 0 })
    expect(new Int16Array(buffers.water.floor)[2 + 2 * 32]).toBe(3) // the shared floor the mesh workers read
  })

  it('looks through a thin floating run (a bridge) but not through a thick roof: water under a roof is static', () => {
    const { at } = world((x, y) => {
      if (y < 3) return ID.stone
      if (y <= 5) return water(7)
      if (x === 4 && y >= 8 && y <= 10) return ID.stone // a 3-thick bridge over air
      if (x === 6 && y >= 6 && y <= 14) return ID.stone // a 9-thick roof right on the water
      return AIR
    })
    expect(at(4, 4)).toEqual({ floor: 3, depth: 3 * SUB })
    expect(at(6, 4)).toEqual({ floor: 15, depth: 0 })
  })

  it('reads a chunk that is all water (a uniform chunk)', () => {
    const { at, mirror } = world((_x, y) => (y < 32 ? water(7) : AIR))
    expect(at(9, 9)).toEqual({ floor: 0, depth: 32 * SUB })
    expect(mirror.q[9 + 9 * 32]).toBe(32 * 8)
  })

  it('forces a rewrite of a run that is not the canonical mirror, up to its top', () => {
    const { at, mirror } = world((_x, y) => (y < 3 ? ID.stone : y === 3 ? water(3) : y === 4 ? water(7) : AIR))
    expect(at(1, 1)).toEqual({ floor: 3, depth: 12 * UNIT })
    expect(mirror.q[1 + 32]).toBe(~(5 * 8))
  })

  it('rests water on a spring: the spring is its column\'s floor block', () => {
    const { at } = world((x, y, z) => (y < 3 ? ID.stone : x === 5 && z === 5 && y === 3 ? packVoxel(8, 4) : y <= 5 ? water(7) : AIR))
    expect(at(5, 5)).toEqual({ floor: 4, depth: 2 * SUB })
  })

  it('reports the floors that moved and zeroes the rebuilt columns\' fluxes', () => {
    const { store, cols, mirror } = world((_x, y) => (y < 3 ? ID.stone : AIR))
    cols.flux.fill(160)
    store.setVoxel(7, 3, 7, ID.stone)
    store.commit()
    const moved: number[][] = []
    rebuildColumns(store, kind, cols, mirror, 0, 0, 32, 32, (x, z, from, to) => moved.push([x, z, from, to]))
    expect(moved).toEqual([[7, 7, 3, 4]])
    expect(cols.flux.every((f) => f === 0)).toBe(true)
  })
})
