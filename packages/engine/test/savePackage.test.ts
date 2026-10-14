import { describe, expect, it } from 'vitest'
import { MemoryStore, checkSlotName } from '../src/persist/store.ts'
import { SaveError, checkBlocks, checkManifest, checkSystemSections, type ManifestDraft } from '../src/persist/manifest.ts'
import { gcBlobs, readSave, writeSave } from '../src/persist/package.ts'
import { SECTION_VERSIONS } from '../src/sim/snapshot.ts'

const draft = (over: Partial<ManifestDraft> = {}): ManifestDraft => ({
  format: 'elovox-save', formatVersion: 1, engine: '0.1.0', created: new Date(0).toISOString(), seed: 1, size: [512, 32, 256], tick: 7, paused: false,
  blocks: ['air', 'stone'], terrain: null, meta: { scene: 'test' }, regionFormat: 1, ...over,
})
const bytes = (n: number, v = 1) => new Uint8Array(n).fill(v)
const sections = () => (['scheduler', 'water', 'gravity', 'collapse', 'app'] as const).map(name => ({ name, bytes: bytes(100, name.length) }))
const regions = () => [{ r: 0, bytes: bytes(5000, 1) }, { r: 1, bytes: bytes(5000, 2) }]

describe('save package', () => {
  it('writes blobs then the manifest and reads everything back verified', async () => {
    const store = new MemoryStore()
    const w = await writeSave(store, 'a', draft(), sections(), regions(), [])
    expect(w.regionsWritten).toBe(2)
    const back = await readSave(store, 'a')
    expect(back.manifest.tick).toBe(7)
    expect(back.regions.map(r => r.bytes)).toEqual(regions().map(r => r.bytes))
    expect(back.sections.water).toEqual(bytes(100, 5))
    expect(back.manifest.sections.find(s => s.name === 'water')!.version).toBe(SECTION_VERSIONS.water)
  })
  it('does not write a blob twice and reuses regions from the previous manifest', async () => {
    const store = new MemoryStore()
    const first = await writeSave(store, 'a', draft(), sections(), regions(), [])
    const again = await writeSave(store, 'a', draft({ tick: 8 }), sections(), [{ r: 1, bytes: bytes(5000, 3) }], first.manifest.regions.filter(r => r.r === 0))
    expect(again.blobsWritten).toBe(1)
    expect(again.manifest.generation).toBe(first.manifest.generation + 1)
    expect((await readSave(store, 'a')).regions[0]!.bytes).toEqual(bytes(5000, 1))
  })
  it('refuses a package with missing regions', async () => {
    await expect(writeSave(new MemoryStore(), 'a', draft(), sections(), [regions()[0]!], [])).rejects.toThrow(/region 1/)
  })
  it('keeps the previous manifest readable when a write fails, and reports quota', async () => {
    const store = new MemoryStore()
    await writeSave(store, 'a', draft(), sections(), regions(), [])
    store.failWrites = 'quota'
    const err = await writeSave(store, 'a', draft({ tick: 99 }), sections(), [{ r: 0, bytes: bytes(5000, 9) }, { r: 1, bytes: bytes(10, 9) }], []).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SaveError)
    expect((err as SaveError).code).toBe('quota')
    store.failWrites = undefined
    expect((await readSave(store, 'a')).manifest.tick).toBe(7)
  })
  it('rewrites a blob a failed write left truncated, so the next save of the same data loads', async () => {
    const store = new MemoryStore()
    store.failWrites = 'quota'; store.partialWrites = true
    await expect(writeSave(store, 'a', draft(), sections(), regions(), [])).rejects.toMatchObject({ code: 'quota' })
    store.failWrites = undefined; store.partialWrites = false
    await writeSave(store, 'a', draft(), sections(), regions(), [])
    expect((await readSave(store, 'a')).regions.map(r => r.bytes)).toEqual(regions().map(r => r.bytes))
  })
  it('refuses to publish a manifest whose reused regions are gone (deleted while the save ran)', async () => {
    const store = new MemoryStore()
    const first = await writeSave(store, 'a', draft(), sections(), regions(), [])
    await store.deleteSlot('a'); await gcBlobs(store)
    await expect(writeSave(store, 'a', draft(), sections(), [{ r: 1, bytes: bytes(5000, 3) }], first.manifest.regions.filter(r => r.r === 0))).rejects.toMatchObject({ code: 'stale' })
    expect(await store.readManifest('a')).toBeNull()
  })
  it('detects a corrupted or missing blob', async () => {
    const store = new MemoryStore()
    const w = await writeSave(store, 'a', draft(), sections(), regions(), [])
    const h = w.manifest.regions[0]!.hash
    const blob = (await store.readBlob(h))!
    blob[blob.length - 1]! ^= 0xff
    await store.writeBlob(h, blob)
    await expect(readSave(store, 'a')).rejects.toMatchObject({ code: 'corrupted' })
    await store.deleteBlob(h)
    await expect(readSave(store, 'a')).rejects.toMatchObject({ code: 'corrupted' })
  })
  it('refuses a missing slot and an incompatible save', async () => {
    const store = new MemoryStore()
    await expect(readSave(store, 'nope')).rejects.toMatchObject({ code: 'missing' })
    await writeSave(store, 'a', draft({ formatVersion: 2 }), sections(), regions(), [])
    await expect(readSave(store, 'a')).rejects.toMatchObject({ code: 'incompatible', message: expect.stringContaining('format v2, engine expects v1') })
  })
  it('names every incompatibility', () => {
    const m = { ...draft({ formatVersion: 2, regionFormat: 3 }), generation: 1, regions: [], sections: [{ name: 'water' as const, version: 9, hash: 'x', bytes: 1 }] }
    expect(checkManifest(m)).toEqual(['format v2, engine expects v1', 'region format v3, engine expects v1', `section water v9, engine expects v${SECTION_VERSIONS.water}`])
    expect(checkBlocks(['air', 'stone'], ['air', 'stone', 'glass'])).toEqual([])
    expect(checkBlocks(['air', 'dirt'], ['air', 'stone'])).toEqual(['block 1 is "dirt" in the save but "stone" in this engine'])
    expect(checkBlocks(['air', 'stone', 'x'], ['air', 'stone'])).toEqual(['block 2 "x" is unknown to this engine'])
  })
  it('stamps a system section with its own version and checkManifest leaves it to the game', async () => {
    const w = await writeSave(new MemoryStore(), 'a', draft(), [...sections(), { name: 'system:colony', version: 3, bytes: bytes(20, 3) }], regions(), [])
    const manifest = w.manifest
    expect(manifest.sections.find(s => s.name === 'system:colony')!.version).toBe(3)
    expect(checkManifest(manifest)).toEqual([])
    expect(checkSystemSections(manifest, [{ name: 'colony', version: 3 }])).toEqual([])
    expect(checkSystemSections(manifest, [{ name: 'colony', version: 4 }])).toEqual(['section system:colony v3, game expects v4'])
    expect(checkSystemSections(manifest, [])).toEqual(['section system:colony is unknown to this game'])
  })
  it('collects blobs no kept manifest references', async () => {
    const store = new MemoryStore()
    await writeSave(store, 'a', draft(), sections(), regions(), [])
    await writeSave(store, 'a', draft(), sections(), [{ r: 0, bytes: bytes(10, 7) }, { r: 1, bytes: bytes(10, 8) }], [])
    const third = await writeSave(store, 'a', draft(), sections(), [{ r: 0, bytes: bytes(10, 5) }, { r: 1, bytes: bytes(10, 6) }], [])
    // The first generation's regions are gone; the second and third generations stay readable.
    expect((await store.listBlobs()).length).toBe(sections().length + 4)
    expect(await gcBlobs(store)).toBe(0)
    expect(third.manifest.generation).toBe(3)
    await store.deleteSlot('a')
    expect(await gcBlobs(store)).toBeGreaterThan(0)
    expect(await store.listBlobs()).toEqual([])
  })
  it('validates slot names', () => {
    expect(() => checkSlotName('ok name_1-2')).not.toThrow()
    for (const bad of ['', '../x', 'a/b', 'x'.repeat(41)]) expect(() => checkSlotName(bad)).toThrow(SaveError)
  })
})
