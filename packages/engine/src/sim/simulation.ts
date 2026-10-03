import { BlockRegistry, type BlockDef } from '../blocks/registry.ts'
import type { WorldBuffers } from '../world/buffers.ts'
import { ChunkStore, WorldFullError } from '../world/chunkStore.ts'
import { CHUNK_VOLUME, type Layout } from '../world/layout.ts'
import { AIR, voxelId, voxelState, withState } from '../world/voxel.ts'
import {
  compareStamped, validateCommand,
  type Ack, type Command, type FillRegionCommand, type SetBlockCommand, type StampedCommand,
} from './commands.ts'
import { diffMask, forNeighbours } from './chunkDiff.ts'
import { makeColumnContext, type GeneratorModule } from './generator.ts'
import { LightEngine, RELIGHT_MARGIN } from './light.ts'
import { Pcg32, hash32 } from './rng.ts'
import type { BlockCallback, BlockRules, CommandHandler, RuleContext, RulesModule } from './rules.ts'
import { Scheduler } from './scheduler.ts'

export interface SimulationOptions {
  buffers: WorldBuffers
  blocks: readonly BlockDef[]
  rules?: RulesModule
  seed: number
  workCap?: number
  /** replaceColumns diffs light only over at most this many chunks; above it (a whole-world regeneration) it remeshes every relit chunk. Default 1024. */
  regenLightDiffLimit?: number
  randomTicksPerChunk?: number
  maxPages?: number
  commandLogLimit?: number
  onNewPage?: (index: number, page: SharedArrayBuffer) => void
  log?: (message: string) => void
}

export interface SimEvent { tick: number; type: string; payload?: unknown }
export interface TickResult { tick: number; dirtyChunks: number[]; events: SimEvent[]; acks: Ack[] }

const DX = [1, -1, 0, 0, 0, 0]
const DY = [0, 0, 1, -1, 0, 0]
const DZ = [0, 0, 0, 0, 1, -1]

export class Simulation {
  readonly store: ChunkStore
  readonly registry: BlockRegistry
  readonly light: LightEngine
  readonly layout: Layout
  tick = 0
  readonly commandLog: StampedCommand[] = []

  private pending: StampedCommand[] = []
  private readonly scheduler = new Scheduler()
  private neighbors: number[] = []
  private neighborHead = 0
  private events: SimEvent[] = []
  private readonly rng = new Pcg32()
  private readonly byId: (BlockRules | undefined)[]
  private readonly handlers: Map<string, CommandHandler>
  private readonly customTypes: Set<string>
  private readonly hasRandom: boolean
  private readonly ctx: RuleContext
  private readonly seed: number
  private readonly workCap: number
  private readonly regenLightDiffLimit: number
  private readonly randomTicks: number
  private readonly logLimit: number
  private readonly logTrimAt: number
  private readonly log: (message: string) => void

  constructor(o: SimulationOptions) {
    this.registry = new BlockRegistry(o.blocks)
    this.store = new ChunkStore({ buffers: o.buffers, opaque: this.registry.opaque, onNewPage: o.onNewPage, maxPages: o.maxPages })
    this.layout = this.store.layout
    this.light = new LightEngine(this.store, { opaque: this.registry.opaque, emits: this.registry.emits })
    this.seed = o.seed
    this.workCap = o.workCap ?? 50_000
    this.regenLightDiffLimit = o.regenLightDiffLimit ?? 1024
    this.randomTicks = o.randomTicksPerChunk ?? 3
    this.logLimit = o.commandLogLimit ?? 100_000
    this.logTrimAt = this.logLimit + Math.floor(this.logLimit / 10) // trim in batches past 1.1 × the limit
    this.log = o.log ?? ((m) => console.warn(m))
    const blockRules = o.rules?.blocks ?? {}
    for (const name of Object.keys(blockRules)) this.registry.id(name) // throws for unknown blocks
    this.byId = this.registry.defs.map((d) => blockRules[d.name])
    this.hasRandom = this.byId.some((r) => r?.onRandomTick)
    this.handlers = new Map(Object.entries(o.rules?.commands ?? {}))
    this.customTypes = new Set(this.handlers.keys())
    this.ctx = this.makeContext()
  }

  get pendingWork(): number { return this.neighbors.length - this.neighborHead + this.scheduler.size }

  submit(clientId: number, seq: number, cmd: Command): void {
    this.pending.push({ tick: this.tick, clientId, seq, cmd })
  }

  /** Hands the generator its document (GeneratorModule.configure). Throws if the generator rejects it. */
  configure(gen: GeneratorModule, doc: unknown): void {
    gen.configure?.(doc, { size: this.layout.size, seed: this.seed, id: (name) => this.registry.id(name) })
  }

  /** Runs the generator for chunk column (cx, cz) into `column` (32 × 32 × height voxels, cleared to air first). */
  generateColumnData(gen: GeneratorModule, cx: number, cz: number, column: Uint16Array): void {
    column.fill(AIR)
    gen.generateColumn(makeColumnContext(this.seed, this.layout.size[1], (name) => this.registry.id(name), column), cx, cz)
  }

  /** Writes a generated column into the world. Chunks stay open until finishGenerate or replaceColumns commits. */
  applyColumn(cx: number, cz: number, column: Uint16Array): void {
    const L = this.layout
    if (column.length !== 32 * 32 * L.size[1]) throw new RangeError(`column has ${column.length} voxels, expected ${32 * 32 * L.size[1]}`)
    for (let cy = 0; cy < L.cy; cy++) {
      this.store.writeChunkDense(L.chunkIndex(cx, cy, cz), column.subarray(cy * 32768, (cy + 1) * 32768))
    }
  }

  /** After every column is applied: the initial light pass, then commit. Returns every chunk index. */
  finishGenerate(): number[] {
    // No commit between the dense writes and initialize(): initialize writes slots directly and
    // relies on generation having left those chunks open. Commit after, so every version is even.
    this.light.initialize()
    this.store.commit()
    return Array.from({ length: this.layout.chunkCount }, (_, i) => i)
  }

  /**
   * Swaps in freshly generated columns between ticks. Only chunks whose voxels differ are written;
   * light is recomputed around them, and the result lists only the chunks whose voxels or light
   * changed plus the neighbours that see a changed border (see forNeighbours). Unchanged columns
   * cost a compare and nothing else.
   */
  replaceColumns(cols: readonly { cx: number; cz: number; data: Uint16Array }[]): number[] {
    const L = this.layout, store = this.store
    // 1. Find the changed chunks. Nothing is written yet: the light snapshot needs the old world.
    const vox = new Uint16Array(CHUNK_VOLUME)
    const writes: { ci: number; data: Uint16Array }[] = []
    const masks = new Map<number, number>()
    let cx0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cz1 = -Infinity
    for (const c of cols) {
      if (c.data.length !== CHUNK_VOLUME * L.cy) throw new RangeError(`column has ${c.data.length} voxels, expected ${CHUNK_VOLUME * L.cy}`)
      for (let cy = 0; cy < L.cy; cy++) {
        const ci = L.chunkIndex(c.cx, cy, c.cz)
        const data = c.data.subarray(cy * CHUNK_VOLUME, (cy + 1) * CHUNK_VOLUME)
        const m = diffMask(store.readVoxels(ci, vox), data)
        if (m === 0) continue
        masks.set(ci, m)
        writes.push({ ci, data })
        cx0 = Math.min(cx0, c.cx); cz0 = Math.min(cz0, c.cz); cx1 = Math.max(cx1, c.cx); cz1 = Math.max(cz1, c.cz)
      }
    }
    if (writes.length === 0) return [] // identical voxels give identical light
    // 2. Light before, wherever the relight can reach.
    const x0 = cx0 * 32, z0 = cz0 * 32, x1 = cx1 * 32 + 32, z1 = cz1 * 32 + 32
    const reach: number[] = []
    const rx0 = Math.max(0, x0 - RELIGHT_MARGIN) >> 5, rz0 = Math.max(0, z0 - RELIGHT_MARGIN) >> 5
    const rx1 = (Math.min(L.size[0], x1 + RELIGHT_MARGIN) - 1) >> 5, rz1 = (Math.min(L.size[2], z1 + RELIGHT_MARGIN) - 1) >> 5
    for (let cy = 0; cy < L.cy; cy++) for (let cz = rz0; cz <= rz1; cz++) for (let cx = rx0; cx <= rx1; cx++) reach.push(L.chunkIndex(cx, cy, cz))
    const before = reach.length <= this.regenLightDiffLimit ? new Map(reach.map((ci) => [ci, store.lightSnapshot(ci)])) : null
    // 3. Write, relight, commit. commit() closes every written or relit chunk; its list over-marks and is only the fallback.
    for (const w of writes) store.writeChunkDense(w.ci, w.data)
    this.light.relightRegion(x0, z0, x1, z1)
    // Light can only differ in a chunk that is open: every write opens one.
    const touched = before ? [...before].filter(([ci]) => store.isOpen(ci)) : []
    const relit = store.commit()
    // 4. What changed, and who sees it.
    const out = new Set<number>(before ? [] : relit)
    if (before) {
      const now = new Uint8Array(CHUNK_VOLUME), was = new Uint8Array(CHUNK_VOLUME)
      for (const [ci, old] of touched) {
        const m = diffMask(typeof old === 'number' ? was.fill(old) : old, store.readLight(ci, now))
        if (m !== 0) masks.set(ci, (masks.get(ci) ?? 0) | m)
      }
    }
    for (const [ci, m] of masks) {
      out.add(ci)
      const [cx, cy, cz] = L.chunkCoords(ci)
      forNeighbours(m, (dx, dy, dz) => {
        if (L.chunkInBounds(cx + dx, cy + dy, cz + dz)) out.add(L.chunkIndex(cx + dx, cy + dy, cz + dz))
      })
    }
    return [...out].sort((a, b) => a - b)
  }

  /** Runs once before tick 0, serially. Returns every chunk index; the mesher skips trivial ones. */
  generate(gen: GeneratorModule): number[] {
    const L = this.layout
    const column = new Uint16Array(32 * 32 * L.size[1])
    for (let cz = 0; cz < L.cz; cz++) for (let cx = 0; cx < L.cx; cx++) {
      this.generateColumnData(gen, cx, cz, column)
      this.applyColumn(cx, cz, column)
    }
    return this.finishGenerate()
  }

  step(): TickResult {
    const t = this.tick
    const acks: Ack[] = []
    let dirtyChunks: number[] = []
    try {
      this.rng.reseed(hash32(this.seed, t))
      // 1. commands
      const cmds = this.pending.sort(compareStamped)
      this.pending = []
      for (const c of cmds) {
        // Commands arrive from postMessage, so the value may not be an object at all.
        const err = typeof c.cmd !== 'object' || c.cmd === null
          ? 'command must be an object'
          : validateCommand(c.cmd, this.layout, this.registry.count, this.customTypes)
        if (err) { acks.push({ clientId: c.clientId, seq: c.seq, ok: false, error: err }); continue }
        // Log before applying: a handler that writes and then throws has still changed the world,
        // and replaying the log re-runs the same handler to the same partial effect.
        this.appendLog(c)
        try {
          this.applyCommand(c.cmd)
          acks.push({ clientId: c.clientId, seq: c.seq, ok: true })
        } catch (e) {
          if (e instanceof WorldFullError) throw e // out of memory is fatal, not a bad command
          const msg = e instanceof Error ? e.message : String(e)
          this.log(`command error type=${c.cmd.type} tick=${t}: ${msg}`)
          acks.push({ clientId: c.clientId, seq: c.seq, ok: false, error: msg })
        }
      }
      // 2. neighbour notifications and scheduled updates, under the work cap.
      // Scheduled updates are drained one at a time so the notifications they cause share the budget.
      let budget = this.processNeighbors(this.workCap)
      while (budget > 0) {
        const [pos] = this.scheduler.drain(t, 1)
        if (pos === undefined) break
        budget--
        this.runAt(pos, 'onScheduledTick')
        budget = this.processNeighbors(budget)
      }
      // 3. random ticks
      if (this.hasRandom) {
        for (let ci = 0; ci < this.layout.chunkCount; ci++) {
          if (this.store.slotOf(ci) < 0) continue
          const [cx, cy, cz] = this.layout.chunkCoords(ci)
          for (let k = 0; k < this.randomTicks; k++) {
            const local = this.rng.nextInt(32768)
            const x = cx * 32 + (local & 31), z = cz * 32 + ((local >> 5) & 31), y = cy * 32 + (local >> 10)
            this.runAt(this.layout.voxelIndex(x, y, z), 'onRandomTick')
          }
        }
        this.processNeighbors(budget)
      }
      // 4. light
      this.light.propagate()
    } finally {
      // 5. always close seqlocks, even if something above threw
      dirtyChunks = this.store.commit()
      this.tick = t + 1
    }
    const events = this.events
    this.events = []
    return { tick: t, dirtyChunks, events, acks }
  }

  hash(): number {
    let h = 0x811c9dc5
    const mix = (v: number) => { h = Math.imul(h ^ v, 0x01000193) }
    mix(this.tick)
    for (let ci = 0; ci < this.layout.chunkCount; ci++) {
      const e = this.store.table[ci]!
      if (e < 0) { mix(e); continue }
      const vox = this.store.views.voxels(e)
      const lt = this.store.views.light(e)
      const v32 = new Uint32Array(vox.buffer, vox.byteOffset, vox.length >> 1)
      const l32 = new Uint32Array(lt.buffer, lt.byteOffset, lt.length >> 2)
      for (let i = 0; i < v32.length; i++) mix(v32[i]!)
      for (let i = 0; i < l32.length; i++) mix(l32[i]!)
    }
    return h >>> 0
  }

  private applyCommand(cmd: Command): void {
    if (cmd.type === 'setBlock') {
      const c = cmd as SetBlockCommand
      this.applySet(c.pos[0], c.pos[1], c.pos[2], c.voxel, true)
      return
    }
    if (cmd.type === 'fillRegion') {
      const c = cmd as FillRegionCommand
      const [x0, y0, z0] = c.min, [x1, y1, z1] = c.max
      for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const shell = x === x0 || x === x1 || y === y0 || y === y1 || z === z0 || z === z1
        this.applySet(x, y, z, c.voxel, shell)
      }
      return
    }
    this.handlers.get(cmd.type)!(this.ctx, cmd)
  }

  private applySet(x: number, y: number, z: number, v: number, notify: boolean): void {
    const old = this.store.getVoxel(x, y, z)
    if (!this.store.setVoxel(x, y, z, v)) return
    this.light.onVoxelChanged(x, y, z, old, v)
    if (!notify) return
    this.neighbors.push(this.layout.voxelIndex(x, y, z))
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
      if (this.layout.inBounds(nx, ny, nz)) this.neighbors.push(this.layout.voxelIndex(nx, ny, nz))
    }
  }

  private processNeighbors(budget: number): number {
    while (budget > 0 && this.neighborHead < this.neighbors.length) {
      budget--
      this.runAt(this.neighbors[this.neighborHead++]!, 'onNeighborChanged')
    }
    if (this.neighborHead === this.neighbors.length) {
      this.neighbors = []
      this.neighborHead = 0
    } else if (this.neighborHead > 4096 && this.neighborHead * 2 > this.neighbors.length) {
      this.neighbors = this.neighbors.slice(this.neighborHead)
      this.neighborHead = 0
    }
    return budget
  }

  private runAt(pos: number, hook: keyof BlockRules): void {
    const [x, y, z] = this.layout.voxelCoords(pos)
    const v = this.store.getVoxel(x, y, z)
    const fn: BlockCallback | undefined = this.byId[voxelId(v)]?.[hook]
    if (!fn) return
    try {
      fn(this.ctx, x, y, z, v)
    } catch (e) {
      if (e instanceof WorldFullError) throw e
      const msg = e instanceof Error ? e.message : String(e)
      this.log(`rule error block=${this.registry.name(voxelId(v))} pos=(${x},${y},${z}) tick=${this.tick}: ${msg}`)
    }
  }

  private appendLog(c: StampedCommand): void {
    this.commandLog.push(c)
    if (this.commandLog.length > this.logTrimAt) this.commandLog.splice(0, this.commandLog.length - this.logLimit)
  }

  private makeContext(): RuleContext {
    const sim = this
    return {
      get tick() { return sim.tick },
      get: (x, y, z) => sim.store.getVoxel(x, y, z),
      set: (x, y, z, v) => {
        if (!Number.isInteger(v) || v < 0 || v > 0xffff || voxelId(v) >= sim.registry.count) throw new Error(`invalid voxel ${v}`)
        sim.applySet(x, y, z, v, true)
      },
      schedule: (x, y, z, delay) => {
        if (!Number.isFinite(delay)) throw new Error(`invalid schedule delay ${delay}`)
        if (!sim.layout.inBounds(x, y, z)) return
        // delay is relative; the scheduler takes an absolute due tick, at least the next one
        sim.scheduler.schedule(sim.layout.voxelIndex(x, y, z), sim.tick + Math.max(1, Math.floor(delay)))
      },
      random: () => sim.rng.next(),
      emit: (type, payload) => { sim.events.push(payload === undefined ? { tick: sim.tick, type } : { tick: sim.tick, type, payload }) },
      id: (name) => sim.registry.id(name),
      isAir: (v) => voxelId(v) === AIR,
      state: (v) => voxelState(v),
      withState: (v, s) => withState(v, s),
    }
  }
}
