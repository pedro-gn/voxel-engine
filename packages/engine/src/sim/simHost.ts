import type { BlockDef } from '../blocks/registry.ts'
import type { FromSim, TerrainRect, ToSim } from '../protocol.ts'
import { WorldFullError } from '../world/chunkStore.ts'
import type { Layout } from '../world/layout.ts'
import type { Ack } from './commands.ts'
import type { GeneratorModule } from './generator.ts'
import { GenPool, type PortLike } from './genPool.ts'
import type { RulesModule } from './rules.ts'
import { Simulation } from './simulation.ts'
import { FragmentOverlapError } from './collapse.ts'

export interface SimModules { rules?: RulesModule; generator: GeneratorModule }
export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

const MAX_CATCH_UP = 4

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

/** Chunk columns overlapping a block rectangle. */
export function columnsIn(r: TerrainRect): [number, number][] {
  const out: [number, number][] = []
  for (let cz = r.z0 >> 5; cz <= (r.z1 - 1) >> 5; cz++) for (let cx = r.x0 >> 5; cx <= (r.x1 - 1) >> 5; cx++) out.push([cx, cz])
  return out
}

interface RegenRequest { id: number; rect: TerrainRect }
interface Column { cx: number; cz: number; data: Uint16Array }

/** Every chunk column, row by row. */
export function allColumns(L: Layout): [number, number][] {
  const out: [number, number][] = []
  for (let cz = 0; cz < L.cz; cz++) for (let cx = 0; cx < L.cx; cx++) out.push([cx, cz])
  return out
}

/** Owns the Simulation inside the sim worker. Wall-clock time only paces ticks; it never enters world state. */
export class SimHost {
  private readonly post: (m: FromSim, transfer?: Transferable[]) => void
  private readonly modules: SimModules
  private readonly clock: Clock
  private sim: Simulation | null = null
  /** Latched by a fatal: nothing is accepted or ticked afterwards. */
  private dead = false
  private stepMs = 50
  private running = false
  private acc = 0
  private last = 0
  private timer: unknown = null
  /** Acks for commands rejected at the boundary; delivered with the next tick's acks. */
  private rejected: Ack[] = []
  private pool: GenPool | null = null
  private blocks: BlockDef[] = []
  private seed = 0
  /** The last full document the generator was configured with (undefined: none). Patches do not update it, so it goes stale; it is used only for the initial pooled generation. */
  private terrain: unknown = undefined
  private readonly regenQueue: RegenRequest[] = []
  /** The regeneration running on the pool, if any. */
  private active: RegenRequest | null = null
  /** Set once the initial generation is in: a patch before that would invalidate its columns. */
  private ready = false

  constructor(post: (m: FromSim, transfer?: Transferable[]) => void, modules: SimModules, clock: Clock = realClock) {
    this.post = post
    this.modules = modules
    this.clock = clock
  }

  /** The simulation, for tests and tools; null before init and after a fatal error. */
  get simulation(): Simulation | null { return this.sim }

  handle(msg: ToSim): void {
    if (this.dead) return
    switch (msg.type) {
      case 'init':
        try {
          const tickHz = msg.options.tickHz ?? 20
          if (!(tickHz > 0) || !Number.isFinite(tickHz)) throw new RangeError(`tickHz must be a finite number > 0, got ${tickHz}`)
          this.stepMs = 1000 / tickHz
          this.sim = new Simulation({
            buffers: msg.buffers, blocks: msg.blocks, rules: this.modules.rules, seed: msg.seed,
            workCap: msg.options.workCap, randomTicksPerChunk: msg.options.randomTicksPerChunk, maxPages: msg.options.maxPages,
            collapse: msg.options.collapse,
            workers: msg.options.workers,
            // only defined keys: an undefined one would override WaterSystem's default
            water: {
              debug: msg.options.debugFluids === true,
              ...(msg.options.waterTileCap !== undefined && { tileCap: msg.options.waterTileCap }),
            },
            onNewPage: (index, page) => this.post({ type: 'page', index, page }),
            log: (message) => this.post({ type: 'log', message }),
          })
          this.sim.setPaused(msg.options.paused === true)
          this.blocks = msg.blocks
          this.seed = msg.seed
          this.terrain = msg.terrain
          if (msg.terrain !== undefined) this.sim.configure(this.modules.generator, msg.terrain)
          if (msg.restore) {
            // Generation workers still get the document, for later regenerations; nothing is generated.
            if (msg.genPorts && msg.genPorts.length > 0) {
              this.pool = new GenPool(msg.genPorts as PortLike[])
              this.pool.onFatal = (message) => this.fail(new Error(`a generation worker refused a patch the sim accepted: ${message}`))
              this.pool.configure(this.terrain, this.sim.layout.size, this.seed, this.blocks)
            }
            const t0 = this.clock.now()
            const chunks = this.sim.restore(msg.restore)
            const L = this.sim.layout
            this.ready = true
            this.post({ type: 'ready', chunks, slotsUsed: this.sim.store.slotsUsed(), genMs: this.clock.now() - t0, columns: L.cx * L.cz })
            return
          }
          if (msg.genPorts && msg.genPorts.length > 0) {
            this.pool = new GenPool(msg.genPorts as PortLike[])
            this.pool.onFatal = (message) => this.fail(new Error(`a generation worker refused a patch the sim accepted: ${message}`))
            this.generateInPool()
            return
          }
          const t0 = this.clock.now()
          const chunks = this.sim.generate(this.modules.generator)
          const L = this.sim.layout
          this.ready = true
          this.post({ type: 'ready', chunks, slotsUsed: this.sim.store.slotsUsed(), genMs: this.clock.now() - t0, columns: L.cx * L.cz })
        } catch (e) {
          this.fail(e)
        }
        return
      case 'submit':
        if (!this.sim) return
        // A NaN or fractional id would break the (tick, clientId, seq) command ordering.
        if (!Number.isInteger(msg.clientId) || !Number.isInteger(msg.seq)) {
          this.rejected.push({ clientId: msg.clientId, seq: msg.seq, ok: false, error: 'clientId and seq must be integers' })
          return
        }
        this.sim.submit(msg.clientId, msg.seq, msg.cmd)
        return
      case 'start':
        if (this.running || !this.sim) return
        this.running = true
        this.acc = 0
        this.last = this.clock.now()
        this.timer = this.clock.setTimeout(() => this.pump(), this.stepMs)
        return
      case 'stop':
        this.running = false
        this.clock.clearTimeout(this.timer)
        return
      case 'setTerrain':
        this.setTerrain(msg.id, msg.doc)
        return
      case 'patchTerrain':
        this.patchTerrain(msg.id, msg.patch)
        return
      case 'regenerate': {
        if (!this.sim) return
        const [sx, , sz] = this.sim.layout.size
        const r = msg.rect
        const ok = typeof r === 'object' && r !== null && [r.x0, r.z0, r.x1, r.z1].every(Number.isInteger) &&
          r.x0 >= 0 && r.z0 >= 0 && r.x0 < r.x1 && r.z0 < r.z1 && r.x1 <= sx && r.z1 <= sz
        if (!ok) {
          this.post({ type: 'regenerated', id: msg.id, ok: false, message: `rect must be integers with 0 <= x0 < x1 <= ${sx} and 0 <= z0 < z1 <= ${sz}` })
          return
        }
        this.regenQueue.push({ id: msg.id, rect: { x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1 } })
        this.nextRegen()
        return
      }
      case 'setPaused':
        this.sim?.setPaused(msg.paused === true)
        return
      case 'waterResync':
        this.sim?.water.republishAll()
        return
      case 'snapshot': {
        // Messages arrive between pumps, so this is always between two ticks; a pooled regeneration lands atomically too.
        const sim = this.sim
        if (!sim || !this.ready) { this.post({ type: 'snapshot', id: msg.id, ok: false, message: 'the world is not ready' }); return }
        try {
          const snapshot = sim.snapshot(msg.since)
          const transfer = [...snapshot.regions.map(r => r.bytes.buffer), ...snapshot.sections.map(s => s.bytes.buffer), snapshot.revisions.buffer]
          this.post({ type: 'snapshot', id: msg.id, ok: true, snapshot }, transfer)
        } catch (e) {
          this.post({ type: 'snapshot', id: msg.id, ok: false, message: errorMessage(e) })
        }
        return
      }
      case 'genLost': {
        const pool = this.pool
        if (!pool) return
        pool.lose(msg.index)
        if (pool.size === 0 && this.pool === pool) this.pool = null // later work runs serially here
        return
      }
    }
  }

  pump(): void {
    if (this.dead || !this.running || !this.sim) return
    const now = this.clock.now()
    this.acc += now - this.last
    this.last = now
    let n = 0
    while (this.acc >= this.stepMs && n < MAX_CATCH_UP && this.running) {
      this.runTick()
      this.acc -= this.stepMs
      n++
    }
    if (this.running && this.acc >= this.stepMs) {
      const dropped = Math.floor(this.acc / this.stepMs)
      this.acc -= dropped * this.stepMs
      this.post({ type: 'log', message: `sim behind: dropped ${dropped} ticks` })
    }
    if (this.running) this.timer = this.clock.setTimeout(() => this.pump(), Math.max(0, this.stepMs - this.acc))
  }

  private setTerrain(id: number, doc: unknown): void {
    const sim = this.sim
    if (!sim) return
    try {
      sim.configure(this.modules.generator, doc)
    } catch (e) {
      this.post({ type: 'terrain', id, ok: false, message: errorMessage(e) })
      return
    }
    this.terrain = doc
    this.post({ type: 'terrain', id, ok: true })
    const pool = this.pool
    if (!pool) return
    pool.configure(doc, sim.layout.size, this.seed, this.blocks)
    this.restartActive()
  }

  private patchTerrain(id: number, patch: unknown): void {
    if (!this.sim) return
    const gen = this.modules.generator
    if (!gen.patch) { this.post({ type: 'terrain', id, ok: false, message: 'the generator does not support patches' }); return }
    if (!this.ready) { this.post({ type: 'terrain', id, ok: false, message: 'the world is still generating' }); return }
    try {
      gen.patch(patch)
    } catch (e) {
      this.post({ type: 'terrain', id, ok: false, message: errorMessage(e) })
      return
    }
    this.post({ type: 'terrain', id, ok: true })
    if (!this.pool) return
    this.pool.patch(patch)
    this.restartActive()
  }

  /** Columns in flight were generated from an older configuration: drop them and run the request again. */
  private restartActive(): void {
    const pool = this.pool, active = this.active
    if (!pool || !active) return
    pool.cancel()
    this.active = null
    this.regenQueue.unshift(active)
    this.nextRegen()
  }

  /** Starts the next queued regeneration unless one is running. */
  private nextRegen(): void {
    const sim = this.sim
    if (!sim || this.active || this.regenQueue.length === 0) return
    const req = this.regenQueue.shift()!
    const columns = columnsIn(req.rect)
    const t0 = this.clock.now()
    const pool = this.pool && this.pool.size > 0 ? this.pool : null
    if (!pool) {
      const H = sim.layout.size[1]
      let cols: Column[]
      try {
        cols = columns.map(([cx, cz]) => {
          const data = new Uint16Array(32 * 32 * H)
          sim.generateColumnData(this.modules.generator, cx, cz, data)
          return { cx, cz, data }
        })
      } catch (e) {
        this.post({ type: 'regenerated', id: req.id, ok: false, message: errorMessage(e) })
        this.nextRegen()
        return
      }
      this.finishRegen(req.id, t0, cols)
      this.nextRegen()
      return
    }
    const cols: Column[] = []
    this.active = req
    pool.run({
      columns,
      onColumn: (cx, cz, data) => { cols.push({ cx, cz, data }) },
      onDone: () => {
        this.active = null
        this.finishRegen(req.id, t0, cols)
        this.nextRegen()
      },
      onError: (message) => {
        this.active = null
        this.post({ type: 'regenerated', id: req.id, ok: false, message })
        this.nextRegen()
      },
    })
  }

  /** Applies a finished regeneration atomically (we are between ticks) and reports the chunks to remesh. */
  private finishRegen(id: number, t0: number, cols: Column[]): void {
    const sim = this.sim
    if (!sim) return
    try {
      const dirtyChunks = sim.replaceColumns(cols)
      this.post({ type: 'regenerated', id, ok: true, dirtyChunks, ms: this.clock.now() - t0, slotsUsed: sim.store.slotsUsed() })
    } catch (e) {
      if (e instanceof FragmentOverlapError) this.post({ type: 'regenerated', id, ok: false, message: e.message })
      else this.fail(e)
    }
  }

  /** Initial generation on the generation workers; 'ready' is posted once every column is in. */
  private generateInPool(): void {
    const sim = this.sim!, pool = this.pool!, L = sim.layout
    const t0 = this.clock.now()
    pool.configure(this.terrain, L.size, this.seed, this.blocks)
    pool.run({
      columns: allColumns(L),
      onColumn: (cx, cz, data) => {
        if (this.sim !== sim) return
        try {
          sim.applyColumn(cx, cz, data)
        } catch (e) {
          pool.cancel()
          this.fail(e)
        }
      },
      onDone: () => {
        if (this.sim !== sim) return
        try {
          const chunks = sim.finishGenerate()
          this.ready = true
          this.post({ type: 'ready', chunks, slotsUsed: sim.store.slotsUsed(), genMs: this.clock.now() - t0, columns: L.cx * L.cz })
        } catch (e) {
          this.fail(e)
        }
      },
      onError: (message) => this.fail(new Error(`terrain generation failed at ${message}`)),
    })
  }

  private runTick(): void {
    const sim = this.sim!
    const t0 = this.clock.now()
    try {
      const r = sim.step()
      if (this.rejected.length > 0) { r.acks.push(...this.rejected); this.rejected = [] }
      this.post({ type: 'tick', ...r, slotsUsed: sim.store.slotsUsed(), tickMs: this.clock.now() - t0 })
    } catch (e) {
      this.fail(e)
    }
  }

  private fail(e: unknown): void {
    this.dead = true
    this.sim = null
    this.running = false
    this.clock.clearTimeout(this.timer)
    const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    this.post(e instanceof WorldFullError ? { type: 'fatal', message, slots: e.slots } : { type: 'fatal', message })
  }
}
