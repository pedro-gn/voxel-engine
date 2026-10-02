import { describe, expect, it } from 'vitest'
import { MeshJobRunner } from '../src/mesh/meshJob.ts'
import { FACE, unpackA, unpackB } from '../src/mesh/vertexFormat.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ChunkStore } from '../src/world/chunkStore.ts'
import { ID, testRegistry } from './helpers.ts'
import { meshTables } from './meshHelpers.ts'

function setup(sharePages = true) {
  const reg = testRegistry()
  const buffers = createWorldBuffers([64, 64, 64])
  const runner = new MeshJobRunner(buffers, meshTables())
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
  it('never reports a trivial result under an odd (mid-write) version', () => {
    const { store, runner } = setup()
    const reader = (runner as unknown as { reader: { isTrivial(ci: number): boolean } }).reader
    store.setVoxel(3, 3, 3, ID.stone) // chunk open: odd version
    reader.isTrivial = () => true
    expect(runner.run({ id: 21, chunk: 0 }).type).toBe('retry')
  })
})
