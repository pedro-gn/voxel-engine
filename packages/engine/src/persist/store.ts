import { SaveError, type Manifest, type SaveErrorCode } from './manifest.ts'

/** Where saves live: OPFS in the browser (opfs.ts), memory in tests, a server later. Blobs are named by their hash. */
export interface SaveStore {
  listSlots(): Promise<string[]>
  /** The newest readable manifest of the slot, or null. */
  readManifest(slot: string): Promise<Manifest | null>
  /** Every manifest the store keeps for the slot (gc keeps their blobs). */
  readManifests(slot: string): Promise<Manifest[]>
  /** Atomic: until it resolves, readManifest returns the previous one. */
  writeManifest(slot: string, m: Manifest): Promise<void>
  deleteSlot(slot: string): Promise<void>
  hasBlob(hash: string): Promise<boolean>
  readBlob(hash: string): Promise<Uint8Array | null>
  writeBlob(hash: string, bytes: Uint8Array): Promise<void>
  listBlobs(): Promise<string[]>
  deleteBlob(hash: string): Promise<void>
  estimate(): Promise<{ usage: number; quota: number } | null>
}

export function checkSlotName(slot: string): void {
  if (typeof slot !== 'string' || !/^[A-Za-z0-9 _-]{1,40}$/.test(slot)) throw new SaveError('invalid', `slot names are 1–40 letters, digits, spaces, _ or -: got ${JSON.stringify(slot)}`)
}

/** In-memory store for tests and Node tools. Keeps the two newest manifests of a slot, like OpfsStore. */
export class MemoryStore implements SaveStore {
  /** Tests: make every write fail with this code. */
  failWrites: SaveErrorCode | undefined
  private readonly slots = new Map<string, Manifest[]>()
  private readonly blobs = new Map<string, Uint8Array>()

  private fail(): void { if (this.failWrites) throw new SaveError(this.failWrites, `memory store: ${this.failWrites}`) }
  async listSlots(): Promise<string[]> { return [...this.slots.keys()].sort() }
  async readManifest(slot: string): Promise<Manifest | null> { const l = this.slots.get(slot); return l?.length ? structuredClone(l[l.length - 1]!) : null }
  async readManifests(slot: string): Promise<Manifest[]> { return structuredClone(this.slots.get(slot) ?? []) }
  async writeManifest(slot: string, m: Manifest): Promise<void> {
    this.fail()
    const l = this.slots.get(slot) ?? []
    l.push(structuredClone(m))
    this.slots.set(slot, l.slice(-2))
  }
  async deleteSlot(slot: string): Promise<void> { this.slots.delete(slot) }
  async hasBlob(h: string): Promise<boolean> { return this.blobs.has(h) }
  async readBlob(h: string): Promise<Uint8Array | null> { const b = this.blobs.get(h); return b ? b.slice() : null }
  async writeBlob(h: string, b: Uint8Array): Promise<void> { this.fail(); this.blobs.set(h, b.slice()) }
  async listBlobs(): Promise<string[]> { return [...this.blobs.keys()].sort() }
  async deleteBlob(h: string): Promise<void> { this.blobs.delete(h) }
  async estimate(): Promise<{ usage: number; quota: number }> {
    let usage = 0
    for (const b of this.blobs.values()) usage += b.length
    return { usage, quota: Infinity }
  }
}
