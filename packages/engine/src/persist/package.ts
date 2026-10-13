import { gunzip, gzip, sha256 } from './codec.ts'
import { SaveError, checkManifest, type BlobRef, type Manifest, type ManifestDraft } from './manifest.ts'
import { regionGrid } from './regions.ts'
import { checkSlotName, type SaveStore } from './store.ts'
import { SECTION_VERSIONS, type RegionBlob, type SectionName } from '../sim/snapshot.ts'
import { Layout } from '../world/layout.ts'

export interface SectionInput { name: SectionName | 'app'; bytes: Uint8Array }
export interface WriteResult { bytes: number; blobsWritten: number; regionsWritten: number; manifest: Manifest }
/** A save read back and verified: raw (decompressed) section and region bytes. */
export interface LoadedSave { slot: string; manifest: Manifest; sections: Partial<Record<SectionName | 'app', Uint8Array>>; regions: RegionBlob[] }

async function putBlob(store: SaveStore, raw: Uint8Array, count: { written: number; bytes: number }): Promise<BlobRef> {
  const gz = await gzip(raw), hash = await sha256(gz)
  count.bytes += gz.length
  // A blob of the right size is the same blob (its name is its hash); a shorter one is what a failed write left behind.
  if ((await store.blobSize(hash)) !== gz.length) {
    try { await store.writeBlob(hash, gz) } catch (e) { await store.deleteBlob(hash).catch(() => {}); throw e }
    count.written++
  }
  return { hash, bytes: gz.length }
}

/**
 * Writes the blobs the store lacks, then the manifest (spec §3: a save that dies midway leaves the previous manifest valid),
 * then collects blobs no kept manifest references. `reuse`: regions kept from the slot's previous manifest.
 */
export async function writeSave(store: SaveStore, slot: string, draft: ManifestDraft, sections: SectionInput[], regions: RegionBlob[], reuse: Manifest['regions']): Promise<WriteResult> {
  checkSlotName(slot)
  const total = regionGrid(new Layout(draft.size)).count
  const count = { written: 0, bytes: 0 }
  const outRegions = new Map<number, { r: number } & BlobRef>()
  for (const r of reuse) outRegions.set(r.r, r)
  for (let r = 0; r < total; r++) if (!outRegions.has(r) && !regions.some(x => x.r === r)) throw new SaveError('invalid', `the save is missing region ${r} of ${total}`)
  for (const r of regions) outRegions.set(r.r, { r: r.r, ...(await putBlob(store, r.bytes, count)) })
  const outSections: Manifest['sections'] = []
  for (const s of sections) outSections.push({ name: s.name, version: SECTION_VERSIONS[s.name], ...(await putBlob(store, s.bytes, count)) })
  for (const r of reuse) {
    if (regions.some(x => x.r === r.r)) continue
    // Reused from the slot's previous manifest: still there only if nothing deleted the slot while this save ran.
    if ((await store.blobSize(r.hash)) !== r.bytes) throw new SaveError('stale', `region ${r.r} of the previous save is gone; save again in full`)
    count.bytes += r.bytes
  }
  const prev = await store.readManifest(slot)
  const manifest: Manifest = { ...draft, generation: (prev?.generation ?? 0) + 1, sections: outSections, regions: [...outRegions.values()].sort((a, b) => a.r - b.r) }
  await store.writeManifest(slot, manifest)
  await gcBlobs(store)
  return { bytes: count.bytes, blobsWritten: count.written, regionsWritten: regions.length, manifest }
}

async function getBlob(store: SaveStore, ref: BlobRef, what: string): Promise<Uint8Array> {
  const gz = await store.readBlob(ref.hash)
  if (!gz) throw new SaveError('corrupted', `${what} is missing from the store`)
  if ((await sha256(gz)) !== ref.hash) throw new SaveError('corrupted', `${what} does not match its hash`)
  return gunzip(gz)
}

/** Reads the newest manifest of `slot` and every blob it lists, verifying each hash. */
export async function readSave(store: SaveStore, slot: string): Promise<LoadedSave> {
  checkSlotName(slot)
  const manifest = await store.readManifest(slot)
  if (!manifest) throw new SaveError('missing', `no save named "${slot}"`)
  const bad = checkManifest(manifest)
  if (bad.length) throw new SaveError('incompatible', `save "${slot}" cannot be loaded by this engine:\n${bad.join('\n')}`)
  const sections: LoadedSave['sections'] = {}
  for (const s of manifest.sections) sections[s.name] = await getBlob(store, s, `section ${s.name}`)
  const regions: RegionBlob[] = []
  for (const r of manifest.regions) regions.push({ r: r.r, bytes: await getBlob(store, r, `region ${r.r}`) })
  return { slot, manifest, sections, regions }
}

/** Deletes blobs that no kept manifest of any slot references. Returns how many. */
export async function gcBlobs(store: SaveStore): Promise<number> {
  const keep = new Set<string>()
  for (const slot of await store.listSlots()) for (const m of await store.readManifests(slot)) {
    for (const s of m.sections) keep.add(s.hash)
    for (const r of m.regions) keep.add(r.hash)
  }
  let n = 0
  for (const h of await store.listBlobs()) if (!keep.has(h)) { await store.deleteBlob(h); n++ }
  return n
}
