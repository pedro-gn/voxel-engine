import type { FromSim, ToSim } from '../protocol.ts'
import { WorldFullError } from '../world/chunkStore.ts'
import type { Ack } from './commands.ts'
import type { GeneratorModule } from './generator.ts'
import type { RulesModule } from './rules.ts'
import { Simulation } from './simulation.ts'

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

/** Owns the Simulation inside the sim worker. Wall-clock time only paces ticks; it never enters world state. */
export class SimHost {
  private readonly post: (m: FromSim) => void
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

  constructor(post: (m: FromSim) => void, modules: SimModules, clock: Clock = realClock) {
    this.post = post
    this.modules = modules
    this.clock = clock
  }

  handle(msg: ToSim): void {
    if (this.dead) return
    switch (msg.type) {
      case 'init':
        try {
          this.stepMs = 1000 / (msg.options.tickHz ?? 20)
          this.sim = new Simulation({
            buffers: msg.buffers, blocks: msg.blocks, rules: this.modules.rules, seed: msg.seed,
            workCap: msg.options.workCap, randomTicksPerChunk: msg.options.randomTicksPerChunk, maxPages: msg.options.maxPages,
            onNewPage: (index, page) => this.post({ type: 'page', index, page }),
            log: (message) => this.post({ type: 'log', message }),
          })
          const chunks = this.sim.generate(this.modules.generator)
          this.post({ type: 'ready', chunks, slotsUsed: this.sim.store.slotsUsed() })
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
