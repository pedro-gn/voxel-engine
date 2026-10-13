import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/persist/store.ts'
import { handlePersist, type SlotInfo } from '../src/persist/worker.ts'
import { OpfsStore } from '../src/persist/opfs.ts'
import type { ManifestDraft } from '../src/persist/manifest.ts'

const draft: ManifestDraft = { format: 'elovox-save', formatVersion: 1, engine: '0.1.0', created: '2026-10-13T00:00:00.000Z', seed: 1, size: [256, 32, 256], tick: 3, paused: false, blocks: ['air'], terrain: null, meta: { scene: 'living' }, regionFormat: 1 }

describe('persist worker handler', () => {
  it('writes, lists, reads (transferring the bytes) and deletes', async () => {
    const store = new MemoryStore()
    await handlePersist(store, { type: 'write', id: 1, slot: 'one', draft, sections: [{ name: 'app', bytes: new Uint8Array([1, 2]) }], regions: [{ r: 0, bytes: new Uint8Array(10) }], reuse: [] })
    const list = (await handlePersist(store, { type: 'list', id: 2 })).value as SlotInfo[]
    expect(list).toEqual([{ slot: 'one', created: draft.created, tick: 3, size: [256, 32, 256], bytes: expect.any(Number), meta: { scene: 'living' } }])
    const read = await handlePersist(store, { type: 'read', id: 3, slot: 'one' })
    expect(read.transfer.length).toBe(2)
    await handlePersist(store, { type: 'delete', id: 4, slot: 'one' })
    expect((await handlePersist(store, { type: 'list', id: 5 })).value).toEqual([])
    expect(await store.listBlobs()).toEqual([])
  })
  it('answers null for a missing manifest', async () => {
    expect((await handlePersist(new MemoryStore(), { type: 'manifest', id: 1, slot: 'nope' })).value).toBeNull()
  })
  it('reports a browser without OPFS as unavailable', async () => {
    // Node has a navigator but no navigator.storage, like a browser without the origin private file system.
    await expect(OpfsStore.open()).rejects.toMatchObject({ code: 'unavailable' })
  })
})
