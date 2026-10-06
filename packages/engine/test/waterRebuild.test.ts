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
import { rebuildSegments } from '../src/sim/water/rebuild.ts'
import { UnderSegments } from '../src/sim/water/under.ts'

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

  it('rests water hovering over air on the next wall below: its volume is the depth, and the run is rewritten', () => {
    const { at, mirror } = world((x, y, z) => {
      if (y < 3) return ID.stone
      if (x === 2 && z === 2) return y === 10 || y === 11 ? water(7) : AIR // two cells over air
      if (x === 4 && z === 2) return y === 12 ? water(3) : y === 8 || y === 6 ? water(7) : AIR // runs split by air
      if (x === 6 && z === 2) return y === 9 ? water(7) : y === 7 ? ID.stone : AIR // over air, onto a one-block slab
      return AIR
    })
    expect(at(2, 2)).toEqual({ floor: 3, depth: 2 * SUB })
    expect(mirror.q[2 + 2 * 32]).toBe(~(12 * 8))
    expect(at(4, 2)).toEqual({ floor: 3, depth: 2 * SUB + 4 * UNIT })
    expect(at(6, 2)).toEqual({ floor: 8, depth: SUB })
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


function segWorld(fill: (x: number, y: number, z: number) => number, size: [number, number, number] = [32, 64, 32]) {
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
  const under = new UnderSegments(cols.n)
  const mirror = new WaterMirror(cols.n)
  rebuildSegments(store, kind, cols, under, mirror, 0, 0, size[0], size[2])
  /** Column (x, z) bottom-up: its lower segments, then its top ([floor, height)). */
  const segs = (x: number, z: number) => {
    const c = x + z * size[0]
    const out = under.chain(c, []).map((i) => ({ floor: under.floor[i]!, ceil: under.ceil[i]!, depth: under.depth[i]! }))
    out.push({ floor: cols.floor[c]!, ceil: size[1], depth: cols.depth[c]! })
    return out
  }
  return { cols, under, mirror, segs }
}

describe('rebuildSegments', () => {
  it('makes every run of non-wall cells a segment: a bridge and a roof over a lake split it, nothing is static', () => {
    const { segs } = segWorld((x, y) => {
      if (y < 3) return ID.stone
      if (y <= 5) return water(7)
      if (x === 4 && y >= 8 && y <= 10) return ID.stone // a bridge over the lake
      if (x === 6 && y >= 6 && y <= 14) return ID.stone // a roof right on the water
      return AIR
    })
    expect(segs(4, 4)).toEqual([{ floor: 3, ceil: 8, depth: 3 * SUB }, { floor: 11, ceil: 64, depth: 0 }])
    expect(segs(6, 4)).toEqual([{ floor: 3, ceil: 6, depth: 3 * SUB }, { floor: 15, ceil: 64, depth: 0 }])
    expect(segs(9, 4)).toEqual([{ floor: 3, ceil: 64, depth: 3 * SUB }])
  })

  it('drops water hovering over air in a run onto the run floor, and forces its mirror up to its top', () => {
    const { segs, under } = segWorld((x, y, z) => {
      if (y < 2 || y === 9) return ID.stone // a cave [2, 9) under a roof
      if (x === 3 && z === 3 && y === 6) return water(7) // hovering in the cave
      return AIR
    })
    expect(segs(3, 3)[0]).toEqual({ floor: 2, ceil: 9, depth: SUB })
    const i = under.first[3 + 3 * 32]!
    expect(under.mirrorQ[i]).toBe(~(7 * 8))
  })

  it('reads a column solid to the top as an empty top at the height; every other column holds its cave', () => {
    const { cols, under, segs } = segWorld((x, y) => (x === 0 ? ID.stone : y < 2 || y === 5 ? ID.stone : AIR))
    expect(segs(0, 0)).toEqual([{ floor: 64, ceil: 64, depth: 0 }])
    expect(segs(1, 0)).toEqual([{ floor: 2, ceil: 5, depth: 0 }, { floor: 6, ceil: 64, depth: 0 }])
    expect(cols.depth[1]).toBe(0)
    expect(under.count).toBe(31 * 32) // one cave per column but the solid row
  })
})
