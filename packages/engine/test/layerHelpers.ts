import { BlockRegistry, defineBlock } from '../src/blocks/registry.ts'
import { WaterBodies } from '../src/sim/water/bodies.ts'
import { WaterColumns } from '../src/sim/water/columns.ts'
import { WaterEdges } from '../src/sim/water/edges.ts'
import { WaterMirror } from '../src/sim/water/mirror.ts'
import { rebuildSegments, waterKinds } from '../src/sim/water/rebuild.ts'
import { UnderSegments } from '../src/sim/water/under.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ChunkStore } from '../src/world/chunkStore.ts'
import { AIR, packVoxel } from '../src/world/voxel.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'

export const LREG = new BlockRegistry([...TEST_BLOCKS, defineBlock({ name: 'spring', liquid: true, source: 'water', textures: 'water' })])
export const KINDS = waterKinds(LREG, ID.water)
export const wv = (level = 7): number => packVoxel(ID.water, level)
export const STONE = ID.stone
export { AIR }
export type LFill = (x: number, y: number, z: number) => number

/**
 * Columns, lower segments and their edges built from voxels, without a WaterSystem (Tasks 5–6). Every tile holding water
 * starts awake. `step()` steps once with no sea; `segs(x, z)` lists a column bottom-up (lower segments, then its top).
 */
export function layered(fill: LFill, size: [number, number, number] = [32, 32, 32]) {
  const buffers = createWorldBuffers(size)
  const store = new ChunkStore({ buffers, opaque: LREG.opaque })
  const L = store.layout, data = new Uint16Array(32768)
  for (let ci = 0; ci < L.chunkCount; ci++) {
    const [cx, cy, cz] = L.chunkCoords(ci)
    for (let i = 0; i < 32768; i++) data[i] = fill(cx * 32 + (i & 31), cy * 32 + (i >> 10), cz * 32 + ((i >> 5) & 31))
    store.writeChunkDense(ci, data)
  }
  store.commit()
  const [sx, H, sz] = size
  const cols = new WaterColumns(sx, sz, new Int16Array(buffers.water.floor))
  const under = new UnderSegments(cols.n)
  const mirror = new WaterMirror(cols.n)
  rebuildSegments(store, KINDS, cols, under, mirror, 0, 0, sx, sz)
  const edges = new WaterEdges(cols.tiles.count)
  edges.markAll()
  cols.attach(under, edges, H)
  const bodies = new WaterBodies(cols, under, edges)
  bodies.seedFull()
  const wakeWet = () => {
    for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
      const c = x + z * sx
      let wet = cols.depth[c]! > 0
      for (let i = under.first[c]!; i >= 0 && !wet; i = under.next[i]!) wet = under.depth[i]! > 0
      if (wet) cols.tiles.wake(cols.tiles.of(x, z))
    }
  }
  wakeWet()
  const step = (cap = 1 << 20) => { cols.step(cap, null, 0) }
  const settle = (max = 30_000, cap = 1 << 20, each?: () => void) => {
    for (let i = 1; i <= max; i++) { cols.step(cap, null, 0); each?.(); if (cols.tiles.awakeCount() === 0) return i }
    throw new Error(`still awake after ${max} steps: ${cols.tiles.awakeCount()} tiles`)
  }
  const segs = (x: number, z: number) => {
    const c = x + z * sx
    const out = under.chain(c, []).map((i) => ({ floor: under.floor[i]!, ceil: under.ceil[i]!, depth: under.depth[i]! }))
    out.push({ floor: cols.floor[c]!, ceil: H, depth: cols.depth[c]! })
    return out
  }
  return { store, buffers, cols, under, edges, bodies, mirror, step, settle, segs, total: () => cols.total(), wakeWet }
}
