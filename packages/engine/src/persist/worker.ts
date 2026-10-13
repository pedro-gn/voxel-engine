import { SaveError, type Manifest, type ManifestDraft, type SaveErrorCode } from './manifest.ts'
import { OpfsStore } from './opfs.ts'
import { gcBlobs, readSave, writeSave, type SectionInput } from './package.ts'
import { checkSlotName, type SaveStore } from './store.ts'
import type { RegionBlob } from '../sim/snapshot.ts'

/** Main thread → persistence worker. */
export type ToPersist =
  | { type: 'manifest'; id: number; slot: string }
  | { type: 'write'; id: number; slot: string; draft: ManifestDraft; sections: SectionInput[]; regions: RegionBlob[]; reuse: Manifest['regions'] }
  | { type: 'read'; id: number; slot: string }
  | { type: 'list'; id: number }
  | { type: 'delete'; id: number; slot: string }
  | { type: 'estimate'; id: number }

export type FromPersist =
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; code: SaveErrorCode; message: string }

/** One row of a slot list. `bytes`: compressed size of everything the manifest lists. */
export interface SlotInfo { slot: string; created: string; tick: number; size: [number, number, number]; bytes: number; meta: Record<string, string | number> }

/** Answers one request against `store`; `transfer` lists the buffers the reply can hand over without a copy. */
export async function handlePersist(store: SaveStore, msg: ToPersist): Promise<{ value: unknown; transfer: Transferable[] }> {
  switch (msg.type) {
    case 'manifest':
      checkSlotName(msg.slot)
      return { value: await store.readManifest(msg.slot), transfer: [] }
    case 'write':
      return { value: await writeSave(store, msg.slot, msg.draft, msg.sections, msg.regions, msg.reuse), transfer: [] }
    case 'read': {
      const s = await readSave(store, msg.slot)
      const transfer = [...Object.values(s.sections).map(b => b!.buffer), ...s.regions.map(r => r.bytes.buffer)]
      return { value: s, transfer }
    }
    case 'list': {
      const out: SlotInfo[] = []
      for (const slot of await store.listSlots()) {
        const m = await store.readManifest(slot)
        if (m) out.push({ slot, created: m.created, tick: m.tick, size: m.size, bytes: [...m.sections, ...m.regions].reduce((n, b) => n + b.bytes, 0), meta: m.meta })
      }
      return { value: out, transfer: [] }
    }
    case 'delete':
      checkSlotName(msg.slot)
      await store.deleteSlot(msg.slot)
      await gcBlobs(store)
      return { value: null, transfer: [] }
    case 'estimate':
      return { value: await store.estimate(), transfer: [] }
  }
}

/** Call from your game's persist.worker.ts. Opens OPFS on the first request; answers 'unavailable' when it cannot. */
export function runPersistWorker(): void {
  const scope = globalThis as unknown as { postMessage(m: FromPersist, t?: Transferable[]): void; onmessage: ((e: MessageEvent<ToPersist>) => void) | null }
  let store: Promise<SaveStore> | null = null
  // One request at a time: writes and gc must not interleave.
  let chain = Promise.resolve()
  scope.onmessage = (e) => {
    const msg = e.data
    chain = chain.then(async () => {
      try {
        store ??= OpfsStore.open()
        const { value, transfer } = await handlePersist(await store, msg)
        scope.postMessage({ type: 'result', id: msg.id, ok: true, value }, transfer)
      } catch (err) {
        if (!(err instanceof SaveError) || err.code === 'unavailable') store = null // try opening again next time
        const code: SaveErrorCode = err instanceof SaveError ? err.code : 'unavailable'
        scope.postMessage({ type: 'result', id: msg.id, ok: false, code, message: err instanceof Error ? err.message : String(err) })
      }
    })
  }
}
