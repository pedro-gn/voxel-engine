import { SaveError, type Manifest } from './manifest.ts'
import type { SaveStore } from './store.ts'

/** The worker-only sync handle, typed here in case the DOM lib lacks it. */
interface SyncHandle { read(b: Uint8Array, o?: { at: number }): number; write(b: Uint8Array, o?: { at: number }): number; truncate(n: number): void; getSize(): number; flush(): void; close(): void }
type FileHandle = FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> }
type Dir = FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }

const SIDES = ['a', 'b'] as const
const isQuota = (e: unknown) => e instanceof DOMException && e.name === 'QuotaExceededError'

/**
 * Saves in the origin private file system (worker only): `elovox-saves/blobs/<hash>` and `elovox-saves/slots/<slot>.<a|b>.json`.
 * A slot's manifest alternates between its two files, so a write that dies midway leaves the other, previous one readable.
 */
export class OpfsStore implements SaveStore {
  private readonly blobs: Dir
  private readonly slots: Dir
  private constructor(blobs: Dir, slots: Dir) { this.blobs = blobs; this.slots = slots }

  static async open(): Promise<OpfsStore> {
    const storage = (globalThis as { navigator?: { storage?: StorageManager } }).navigator?.storage
    if (!storage?.getDirectory) throw new SaveError('unavailable', 'this browser has no origin private file system (OPFS) to keep saves in')
    const root = await storage.getDirectory()
    const dir = await root.getDirectoryHandle('elovox-saves', { create: true })
    return new OpfsStore(await dir.getDirectoryHandle('blobs', { create: true }) as Dir, await dir.getDirectoryHandle('slots', { create: true }) as Dir)
  }

  private async readFile(dir: Dir, name: string): Promise<Uint8Array | null> {
    let h: FileHandle
    try { h = await dir.getFileHandle(name) as FileHandle } catch { return null }
    const s = await h.createSyncAccessHandle()
    try { const b = new Uint8Array(s.getSize()); s.read(b, { at: 0 }); return b } finally { s.close() }
  }

  private async writeFile(dir: Dir, name: string, bytes: Uint8Array): Promise<void> {
    const h = await dir.getFileHandle(name, { create: true }) as FileHandle
    const s = await h.createSyncAccessHandle()
    try { s.truncate(0); s.write(bytes, { at: 0 }); s.flush() }
    catch (e) { throw isQuota(e) ? new SaveError('quota', 'not enough storage space for this save') : e }
    finally { s.close() }
  }

  /** The slot's readable manifests with the file each came from, oldest first. A torn file is skipped. */
  private async manifests(slot: string): Promise<{ side: typeof SIDES[number]; m: Manifest }[]> {
    const out: { side: typeof SIDES[number]; m: Manifest }[] = []
    for (const side of SIDES) {
      const b = await this.readFile(this.slots, `${slot}.${side}.json`)
      if (!b) continue
      try { out.push({ side, m: JSON.parse(new TextDecoder().decode(b)) as Manifest }) } catch { /* torn write: the other side holds the previous save */ }
    }
    return out.sort((x, y) => x.m.generation - y.m.generation)
  }

  async listSlots(): Promise<string[]> {
    const names = new Set<string>()
    for await (const name of this.slots.keys()) { const m = /^(.*)\.[ab]\.json$/.exec(name); if (m) names.add(m[1]!) }
    return [...names].sort()
  }
  async readManifest(slot: string): Promise<Manifest | null> { const l = await this.manifests(slot); return l[l.length - 1]?.m ?? null }
  async readManifests(slot: string): Promise<Manifest[]> { return (await this.manifests(slot)).map(x => x.m) }
  async writeManifest(slot: string, m: Manifest): Promise<void> {
    const l = await this.manifests(slot)
    const newest = l[l.length - 1]
    await this.writeFile(this.slots, `${slot}.${newest?.side === 'a' ? 'b' : 'a'}.json`, new TextEncoder().encode(JSON.stringify(m)))
  }
  async deleteSlot(slot: string): Promise<void> {
    for (const side of SIDES) try { await this.slots.removeEntry(`${slot}.${side}.json`) } catch { /* absent */ }
  }
  async blobSize(hash: string): Promise<number | null> {
    try { return (await (await this.blobs.getFileHandle(hash)).getFile()).size } catch { return null }
  }
  async readBlob(hash: string): Promise<Uint8Array | null> { return this.readFile(this.blobs, hash) }
  async writeBlob(hash: string, bytes: Uint8Array): Promise<void> { await this.writeFile(this.blobs, hash, bytes) }
  async listBlobs(): Promise<string[]> {
    const out: string[] = []
    for await (const name of this.blobs.keys()) out.push(name)
    return out.sort()
  }
  async deleteBlob(hash: string): Promise<void> { try { await this.blobs.removeEntry(hash) } catch { /* absent */ } }
  async estimate(): Promise<{ usage: number; quota: number } | null> {
    const e = await navigator.storage.estimate?.()
    return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null
  }
}
