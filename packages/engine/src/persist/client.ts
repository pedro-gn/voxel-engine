import { SaveError } from './manifest.ts'
import { unpack } from './pack.ts'
import type { LoadedSave } from './package.ts'
import type { FromPersist, ToPersist } from './worker.ts'

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never
export type PersistRequest = DistributiveOmit<ToPersist, 'id'>

/** Main-thread side of the persistence worker: one promise per request; worker failures become SaveErrors. */
export class PersistClient {
  private seq = 0
  private readonly waits = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void }>()
  private readonly worker: Worker

  constructor(worker: Worker) {
    this.worker = worker
    worker.onmessage = (e: MessageEvent<FromPersist>) => {
      const m = e.data, w = this.waits.get(m.id)
      if (!w) return
      this.waits.delete(m.id)
      if (m.ok) w.resolve(m.value)
      else w.reject(new SaveError(m.code, m.message))
    }
    worker.onerror = (e) => {
      e.preventDefault()
      this.rejectAll(`the persistence worker crashed: ${e.message || 'it failed to load'}`)
    }
  }

  request<T>(msg: PersistRequest, transfer: Transferable[] = [], timeoutMs = 120_000): Promise<T> {
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.waits.delete(id); reject(new SaveError('unavailable', 'the persistence worker did not answer')) }, timeoutMs)
      this.waits.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v as T) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      this.worker.postMessage({ ...msg, id } as ToPersist, transfer)
    })
  }

  terminate(): void {
    this.worker.terminate()
    this.rejectAll('the engine was disposed')
  }

  private rejectAll(message: string): void {
    for (const w of this.waits.values()) w.reject(new SaveError('unavailable', message))
    this.waits.clear()
  }
}

/** A save read and verified in a short-lived persistence worker, before createEngine; `app` is the game's own state. */
export async function openSave(slot: string, persistWorker: () => Worker): Promise<LoadedSave & { app: unknown }> {
  const client = new PersistClient(persistWorker())
  try {
    const s = await client.request<LoadedSave>({ type: 'read', slot })
    return { ...s, app: s.sections.app ? unpack(s.sections.app).json : null }
  } finally {
    client.terminate()
  }
}
