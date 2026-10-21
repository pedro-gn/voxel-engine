import { describe, expect, it } from 'vitest'
import { MeshJobRunner } from '../src/mesh/meshJob.ts'
import { CUT_BIT, FACE, unpackA, unpackB } from '../src/mesh/vertexFormat.ts'
import { unpackInstance } from '../src/render/decorations/extract.ts'
import { CHUNK_VOLUME } from '../src/world/layout.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ChunkStore } from '../src/world/chunkStore.ts'
import { slabState, stairState } from '../src/blocks/shapes.ts'
import { packVoxel } from '../src/world/voxel.ts'
import { ID, testRegistry } from './helpers.ts'
import { meshTables } from './meshHelpers.ts'
import { decoratedMeshTables } from './meshFixtures.ts'

function setup(sharePages = true, tables = meshTables(), size: [number, number, number] = [64, 64, 64]) {
  const reg = testRegistry()
  const buffers = createWorldBuffers(size)
  const runner = new MeshJobRunner(buffers, tables)
  const store = new ChunkStore({ buffers, opaque: reg.opaque, onNewPage: (i, p) => { if (sharePages) runner.addPage(i, p) } })
  return { store, runner }
}

describe('MeshJobRunner', () => {
  it('returns an empty result for trivial chunks without snapshotting', () => {
    const { runner } = setup()
    const r = runner.run({ id: 1, chunk: 0 })
    expect(r).toEqual({ type: 'result', id: 1, chunk: 0, version: 0, data: { opaque: null, cutout: null, translucent: null, liquid: null, grass: null, flowers: null } })
  })
  it('meshes a chunk and reports its version', () => {
    const { store, runner } = setup()
    store.setVoxel(3, 3, 3, ID.stone)
    store.commit()
    const r = runner.run({ id: 2, chunk: 0 })
    expect(r.type).toBe('result')
    if (r.type !== 'result') return
    expect(r.version).toBe(2)
    expect(r.data.opaque!.indices.length).toBe(36)
  })
  it('asks for a retry while the chunk is being written or its page is missing', () => {
    const a = setup()
    a.store.setVoxel(3, 3, 3, ID.stone) // seqlock still odd
    expect(a.runner.run({ id: 3, chunk: 0 }).type).toBe('retry')
    const b = setup(false)
    b.store.setVoxel(3, 3, 3, ID.stone)
    b.store.commit()
    expect(b.runner.run({ id: 4, chunk: 0 }).type).toBe('retry')
  })
  it('reports retry (never throws) with the job id and chunk, then succeeds once the write commits', () => {
    const { store, runner } = setup()
    store.setVoxel(3, 3, 3, ID.stone)
    expect(runner.run({ id: 9, chunk: 0 })).toEqual({ type: 'retry', id: 9, chunk: 0 })
    store.commit()
    expect(runner.run({ id: 9, chunk: 0 }).type).toBe('result')
  })
  it('applies ghost overrides, including in otherwise trivial chunks', () => {
    const { runner } = setup()
    const r = runner.run({ id: 5, chunk: 0, overrides: [[4, 4, 4, ID.stone]] })
    expect(r.type === 'result' && r.data.opaque!.indices.length).toBe(36)
  })
  it('lights a ghost-removed block from its neighbours so the hole is not black', () => {
    const { store, runner } = setup()
    store.setVoxel(3, 10, 3, ID.stone)
    store.setVoxel(4, 10, 3, ID.stone)
    store.setLight(3, 10, 3, 0) // the block about to be dug is dark, as the sim would have it
    store.commit()
    const r = runner.run({ id: 6, chunk: 0, overrides: [[3, 10, 3, 0]] })
    if (r.type !== 'result') throw new Error('expected a result')
    const m = r.data.opaque!
    let checked = 0
    for (let i = 0; i < m.vertices.length; i += 8) {
      if (unpackA(m.vertices[i]!).normal !== FACE.NX) continue // block (4,10,3) facing into the hole
      expect(unpackB(m.vertices[i + 1]!).sky).toBe(15)       // lit from the open sky above the hole
      checked++
    }
    expect(checked).toBe(1)
  })
  it('does not return an EMPTY trivial result when a write commits during the trivial check', () => {
    const { store, runner } = setup()
    const reader = (runner as unknown as { reader: { isTrivial(ci: number): boolean } }).reader
    const orig = reader.isTrivial.bind(reader)
    reader.isTrivial = (ci) => { const t = orig(ci); store.setVoxel(3, 3, 3, ID.stone); store.commit(); return t }
    const r = runner.run({ id: 20, chunk: 0 })
    expect(r.type).toBe('result')
    if (r.type !== 'result') return
    expect(r.version).toBe(2)
    expect(r.data.opaque!.indices.length).toBe(36)
  })
  it('meshes a cut through uniform stone: the layer above is air, the cut tops are flagged', () => {
    // The middle chunk of a 3 × 3 × 3 world of uniform stone: trivial (no faces) until the cut crosses it at world y 48.
    const { store, runner } = setup(true, meshTables(), [96, 96, 96])
    for (let ci = 0; ci < 27; ci++) store.writeChunkDense(ci, new Uint16Array(CHUNK_VOLUME).fill(ID.stone))
    store.commit()
    const mid = store.layout.chunkIndex(1, 1, 1)
    const plain = runner.run({ id: 30, chunk: mid })
    expect(plain.type === 'result' && plain.data.opaque).toBeNull()
    const r = runner.run({ id: 31, chunk: mid, cut: 48 })
    if (r.type !== 'result') throw new Error('expected a result')
    expect(r.cut).toBe(48)
    const v = r.data.opaque!.vertices
    let tops = 0
    for (let i = 0; i < v.length; i += 2) {
      const a = unpackA(v[i]!)
      expect(a.y).toBeLessThanOrEqual(17) // nothing above the cut layer's top
      if (a.normal === FACE.PY) { tops++; expect(a.y).toBe(17); expect(v[i]! & CUT_BIT).not.toBe(0); expect(unpackB(v[i + 1]!).sky).toBe(15) }
    }
    expect(tops).toBeGreaterThan(0)
    expect(plain.type === 'result' && 'cut' in plain).toBe(false)
  })
  it('keeps grass tufts on an open cut top and none on a covered one', () => {
    const { store, runner } = setup(true, decoratedMeshTables())
    store.setVoxel(5, 16, 5, ID.grass)
    store.setVoxel(8, 16, 8, ID.grass); store.setVoxel(8, 17, 8, ID.stone)
    store.commit()
    const r = runner.run({ id: 32, chunk: 0, cut: 16 })
    if (r.type !== 'result') throw new Error('expected a result')
    const g = r.data.grass!, at: number[][] = []
    for (let i = 0; i < g.length; i += 2) { const p = unpackInstance(g[i]!); at.push([p.lx, p.ly, p.lz]) }
    expect(at).toEqual([[5, 16, 5]])
  })
  it('flags a cut top under a slab or stair like one under a cube, not one under a post or glass', () => {
    const { store, runner } = setup()
    // walls at y 16 (the cut layer) with, above them: stone, a stair, an upside-down stair, a top slab, a post, glass
    const above = [ID.stone, packVoxel(ID.stone_stair, stairState(1)), packVoxel(ID.stone_stair, stairState(1, true)),
      packVoxel(ID.stone_slab, slabState(true)), ID.stone_post, ID.glass]
    above.forEach((v, i) => { store.setVoxel(3 + i * 2, 16, 5, ID.stone); store.setVoxel(3 + i * 2, 17, 5, v) })
    store.commit()
    const r = runner.run({ id: 33, chunk: 0, cut: 16 })
    if (r.type !== 'result') throw new Error('expected a result')
    const v = r.data.opaque!.vertices, flagged = new Map<number, boolean>()
    for (let i = 0; i < v.length; i += 2) {
      const a = unpackA(v[i]!)
      if (a.normal === FACE.PY && a.y === 17 && a.z === 5 && unpackB(v[i + 1]!).fx === 0) flagged.set(a.x, (v[i]! & CUT_BIT) !== 0)
    }
    expect([3, 5, 7, 9, 11, 13].map((x) => flagged.get(x))).toEqual([true, true, true, true, false, false])
  })
  it('never reports a trivial result under an odd (mid-write) version', () => {
    const { store, runner } = setup()
    const reader = (runner as unknown as { reader: { isTrivial(ci: number): boolean } }).reader
    store.setVoxel(3, 3, 3, ID.stone) // chunk open: odd version
    reader.isTrivial = () => true
    expect(runner.run({ id: 21, chunk: 0 }).type).toBe('retry')
  })
})
