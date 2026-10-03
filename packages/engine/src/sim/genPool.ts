import type { BlockDef } from '../blocks/registry.ts'
import type { FromGen, ToGen } from '../protocol.ts'
import type { WorldSize } from '../world/layout.ts'

/** The part of MessagePort the pool uses (tests pass fakes). */
export interface PortLike {
  postMessage(m: ToGen, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<FromGen>) => void) | null
}

export interface GenBatch {
  readonly columns: readonly (readonly [number, number])[]
  onColumn(cx: number, cz: number, data: Uint16Array): void
  onDone(): void
  onError(message: string): void
}

/** Jobs in flight per worker: one generating and one waiting, so a worker never idles between jobs. */
const IN_FLIGHT = 2

/** Sim-side view of the generation workers: one batch of columns at a time, spread over every live port. */
export class GenPool {
  private readonly ports: (PortLike | null)[]
  private readonly busy: number[]
  private readonly jobs = new Map<number, { port: number; cx: number; cz: number }>()
  private batch: GenBatch | null = null
  private next = 0
  private remaining = 0
  private nextId = 0
  private epoch = 0
  /** Epoch of the last configure: patches accumulate on it, so a refusal stays fatal until the next one. */
  private configureEpoch = 0
  /** Called when a worker refuses a patch applied on the current configuration. */
  onFatal: ((message: string) => void) | null = null

  constructor(ports: readonly PortLike[]) {
    this.ports = [...ports]
    this.busy = ports.map(() => 0)
    this.ports.forEach((p, i) => { p!.onmessage = (e) => this.onMessage(i, e.data) })
  }

  /** Live workers. */
  get size(): number { return this.ports.filter((p) => p !== null).length }

  get running(): boolean { return this.batch !== null }

  /** Sends a new configuration to every worker. Columns of earlier configurations are ignored from now on. */
  configure(doc: unknown, size: WorldSize, seed: number, blocks: BlockDef[]): void {
    this.epoch++
    this.configureEpoch = this.epoch
    for (const p of this.ports) p?.postMessage({ type: 'configure', epoch: this.epoch, doc, size, seed, blocks })
  }

  /** Sends an incremental change to every worker. Columns generated before it are ignored from now on. */
  patch(patch: unknown): void {
    this.epoch++
    for (const p of this.ports) p?.postMessage({ type: 'patch', epoch: this.epoch, patch })
  }

  run(batch: GenBatch): void {
    if (this.batch) throw new Error('GenPool is busy')
    if (this.size === 0) { batch.onError('no generation workers are running'); return }
    this.batch = batch
    this.next = 0
    this.remaining = batch.columns.length
    if (this.remaining === 0) { this.batch = null; batch.onDone(); return }
    this.pump()
  }

  /** Drops the current batch without calling it back; answers still in flight are ignored. */
  cancel(): void {
    this.batch = null
    this.jobs.clear()
    this.busy.fill(0)
  }

  /** A worker died: stop using it, and fail the current batch (its jobs may never come back). */
  lose(index: number): void {
    const p = this.ports[index]
    if (!p) return
    p.onmessage = null
    this.ports[index] = null
    const b = this.batch
    if (b) { this.cancel(); b.onError('a generation worker stopped') }
  }

  private pump(): void {
    const b = this.batch!
    for (let i = 0; i < this.ports.length; i++) {
      const p = this.ports[i]
      if (!p) continue
      while (this.busy[i]! < IN_FLIGHT && this.next < b.columns.length) {
        const [cx, cz] = b.columns[this.next++]!
        const id = ++this.nextId
        this.jobs.set(id, { port: i, cx, cz })
        this.busy[i]!++
        p.postMessage({ type: 'job', id, cx, cz })
      }
    }
  }

  private onMessage(port: number, m: FromGen): void {
    if (m.type === 'fatal') {
      if (m.epoch >= this.configureEpoch) this.onFatal?.(m.message)
      return
    }
    const job = this.jobs.get(m.id)
    if (!job || job.port !== port || m.epoch !== this.epoch) return // cancelled, stale or foreign
    this.jobs.delete(m.id)
    this.busy[port]!--
    const b = this.batch
    if (!b) return
    if (m.type === 'error') {
      this.cancel()
      b.onError(`column (${job.cx}, ${job.cz}): ${m.message}`)
      return
    }
    this.remaining--
    b.onColumn(m.cx, m.cz, m.data)
    if (this.batch !== b) return // the callback cancelled us
    if (this.remaining === 0) { this.batch = null; b.onDone() } else this.pump()
  }
}
