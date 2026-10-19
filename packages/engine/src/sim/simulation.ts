import { BlockRegistry, type BlockDef } from '../blocks/registry.ts'
import { decodeUniform, type WorldBuffers } from '../world/buffers.ts'
import { ChunkStore, WorldFullError } from '../world/chunkStore.ts'
import { CHUNK_VOLUME, type Layout } from '../world/layout.ts'
import { AIR, blockLight, skyLight, voxelId, voxelState, withState } from '../world/voxel.ts'
import {
  compareStamped, validateCommand,
  type Ack, type Command, type FillRegionCommand, type SetBlockCommand, type StampedCommand, type Vec3,
} from './commands.ts'
import { diffMask, forNeighbours } from './chunkDiff.ts'
import { makeColumnContext, type GeneratorModule } from './generator.ts'
import { GravitySystem, type FallingBodyState, type Landing } from './gravity.ts'
import { CollapseSystem, FragmentOverlapError, type CollapseOptions, type CollapseStats, type CollapseTick } from './collapse.ts'
import { LightEngine, RELIGHT_MARGIN } from './light.ts'
import { JobRunner } from './jobs.ts'
import { Pcg32, hash32 } from './rng.ts'
import type { BlockCallback, BlockRules, CommandHandler, RuleContext, RulesModule } from './rules.ts'
import { Scheduler } from './scheduler.ts'
import type { WaterTick } from './water/publish.ts'
import { WaterSystem, type WaterOptions } from './water/waterSystem.ts'
import { WorkerSystem } from './workers/workers.ts'
import { WORKER_COMMANDS, type WorkerOptions, type WorkerTick } from './workers/types.ts'
import { pack, unpack, type Packed } from '../persist/pack.ts'
import { decodeRegion, encodeRegion } from '../persist/regions.ts'
import type { RegionBlob, SectionName, SimRestore, SimSnapshot } from './snapshot.ts'
import type { WorkersSnapshot } from './workers/snapshot.ts'
import { SystemRunner, refuseSystemSections, type GameSystem, type SystemContext, type SystemPublication, type SystemUnits } from './systems.ts'

export interface SimulationOptions {
  buffers: WorldBuffers
  blocks: readonly BlockDef[]
  rules?: RulesModule
  seed: number
  workCap?: number
  /** Region-job budget: visited cells per tick. Default 50 000. */
  jobCap?: number
  /** Heightfield water options (tile cap, debug check). */
  water?: Partial<WaterOptions>
  collapse?: CollapseOptions
  workers?: WorkerOptions
  /** replaceColumns diffs light only over at most this many chunks; above it (a whole-world regeneration) it remeshes every relit chunk. Default 1024. */
  regenLightDiffLimit?: number
  randomTicksPerChunk?: number
  maxPages?: number
  commandLogLimit?: number
  onNewPage?: (index: number, page: SharedArrayBuffer) => void
  log?: (message: string) => void
  /** Game systems, ticked in this order after the worker units (spec §2). */
  systems?: readonly GameSystem[]
}

export interface SimEvent { tick: number; type: string; payload?: unknown }
export interface TickResult {
  workers?: WorkerTick
  tick: number; dirtyChunks: number[]; events: SimEvent[]; acks: Ack[]
  /** Bodies still falling after this tick. */
  falling: FallingBodyState[]
  /** Bodies that landed this tick, with their chunk's version after commit. */
  landed: Landing[]
  collapse?: CollapseTick
  /** Awake water tiles, the wet columns in them and queued region jobs after this tick; busy: a tile is awake, a job is queued or a body falls. */
  physics: { waterTiles: number; waterColumns: number; waterBodies: number; waterLayersHidden: number; jobs: number; busy: boolean; collapse?: CollapseStats }
  /** The heightfield tiles published this tick (null: none changed); the main thread reads them from shared memory. */
  water: WaterTick | null
  /** Game system publications of this tick, in system order; absent when none published. */
  systems?: SystemPublication[]
}

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
  /** Per chunk: bumped on every voxel write. Region jobs compare it to notice a world that changed under them. */
  readonly epochs: Uint32Array
  readonly jobs: JobRunner
  readonly water: WaterSystem
  readonly gravity: GravitySystem
  readonly collapse: CollapseSystem
  readonly workers?: WorkerSystem
  readonly systems: SystemRunner | null
  /** Command types a submit may name: rule handlers, worker commands and `name:` commands of the game systems. */
  private readonly commandTypes: { has(type: string): boolean }
  private collapseWrite = false
  private isPaused = false
  private isVoid = false
  private readonly jobCap: number

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
  /** Per block id: 1 if the block has an onRandomTick rule. */
  private readonly randomRule: Uint8Array
  /** False when no block defines onNeighborChanged: writes then skip the notification queue entirely. */
  private readonly hasNeighborRules: boolean
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
    this.store = new ChunkStore({ buffers: o.buffers, opaque: this.registry.blocksLight, onNewPage: o.onNewPage, maxPages: o.maxPages })
    this.layout = this.store.layout
    this.epochs = new Uint32Array(this.layout.chunkCount)
    this.jobs = new JobRunner(this.layout, this.epochs, (x, y, z) => this.store.getVoxel(x, y, z))
    this.jobCap = o.jobCap ?? 50_000
    const sim = this
    this.water = new WaterSystem({
      layout: this.layout, registry: this.registry, store: this.store, buffers: o.buffers.water,
      get: (x, y, z) => sim.store.getVoxel(x, y, z),
      setQuiet: (x, y, z, v) => { const old = sim.workers ? sim.store.getVoxel(x, y, z) : AIR; if (sim.store.setVoxelQuiet(x, y, z, v)) { sim.epochs[sim.layout.chunkOf(x, y, z)]!++; sim.workers?.afterWrite(x, y, z, old, v) } },
      log: (m) => sim.log(m),
    }, o.water)
    this.gravity = new GravitySystem({
      trackSweeps: o.workers !== undefined,
      layout: this.layout, registry: this.registry,
      get: (x, y, z) => sim.store.getVoxel(x, y, z),
      write: (x, y, z, v) => sim.applySet(x, y, z, v, true),
      floorAt: (x, z, from, to) => sim.collapse.floor(x, z, from, to),
    })
    this.collapse = new CollapseSystem({
      trackSweeps: o.workers !== undefined,
      layout: this.layout, registry: this.registry,
      get: (x, y, z) => sim.store.getVoxel(x, y, z),
      write: (x, y, z, v) => { sim.collapseWrite = true; try { sim.applySet(x, y, z, v, true) } finally { sim.collapseWrite = false } },
      prepare: chunks => sim.store.prepareChunks(chunks),
      touch: chunks => sim.store.touchChunks(chunks),
      fallingFloor: (x, z, from, to) => sim.gravity.floorAt(x, z, from, to),
    }, o.collapse)
    this.light = new LightEngine(this.store, { opaque: this.registry.blocksLight, emits: this.registry.emits })
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
    this.randomRule = Uint8Array.from(this.byId, (r) => (r?.onRandomTick ? 1 : 0))
    this.hasRandom = this.randomRule.includes(1)
    this.hasNeighborRules = this.byId.some((r) => r?.onNeighborChanged)
    this.handlers = new Map(Object.entries(o.rules?.commands ?? {}))
    this.customTypes = new Set(this.handlers.keys())
    if (o.workers !== undefined) {
      for (const name of WORKER_COMMANDS) { if (this.customTypes.has(name)) throw new Error(`reserved worker command ${name}`); this.customTypes.add(name) }
      this.workers = new WorkerSystem({
        layout: this.layout, registry: this.registry, get: (x, y, z) => sim.store.getVoxel(x, y, z),
        edit: (pos, expected, value, commit) => sim.editIf(pos, expected, value, commit),
        safe(x, y, z) {
          const id = y === 0 ? 0 : voxelId(sim.store.getVoxel(x, y - 1, z))
          const feet = voxelId(sim.store.getVoxel(x, y, z))
          // Units wade through water up to one block: the feet cell may hold water, the head cell may not hold any liquid.
          // The region layer reads the same head-cell rule (NavigationSystem.regionStand), so routes never cross what this refuses.
          const head = y + 1 >= sim.layout.size[1] ? 0 : voxelId(sim.store.getVoxel(x, y + 1, z))
          return !(sim.registry.liquid[feet] && (sim.registry.liquidGroup[feet] !== sim.water.water || sim.registry.source[feet])) && !sim.registry.liquid[head] && !sim.registry.falls[id] && !(sim.registry.collapses[id] && sim.collapse.checking) && !sim.collapse.overlaps(x, y, z) && !sim.collapse.overlaps(x, y + 1, z)
        },
        wadeable(x, y, z) {
          // safe() without its head-cell rule: what a unit caught by rising water may walk through on its way out.
          const id = y === 0 ? 0 : voxelId(sim.store.getVoxel(x, y - 1, z))
          const feet = voxelId(sim.store.getVoxel(x, y, z))
          return !(sim.registry.liquid[feet] && (sim.registry.liquidGroup[feet] !== sim.water.water || sim.registry.source[feet])) && !sim.registry.falls[id] && !(sim.registry.collapses[id] && sim.collapse.checking) && !sim.collapse.overlaps(x, y, z) && !sim.collapse.overlaps(x, y + 1, z)
        },
        depth: (x, y, z) => sim.water.depthAt(x, y, z),
        hazard: (x, y, z) => sim.gravity.sweptOverlaps(x, y, z) || sim.collapse.sweptOverlaps(x, y, z),
        dynamicBusy: () => sim.water.cols.tiles.awakeCount() > 0 || sim.gravity.count > 0 || sim.collapse.busy,
        emit: (type, payload) => sim.events.push({ tick: sim.tick, type, payload }),
        uniform: (x, y, z) => { const e = sim.store.table[sim.layout.chunkOf(x, y, z)]!; return e < 0 ? decodeUniform(e) : undefined },
      }, o.workers)
    }
    this.ctx = this.makeContext()
    this.systems = o.systems?.length ? new SystemRunner(o.systems, o.seed, this.customTypes, (rng, runner) => this.makeSystemContext(rng, runner)) : null
    const custom = this.customTypes, systems = this.systems
    this.commandTypes = { has: (t) => custom.has(t) || (systems?.owns(t) ?? false) }
  }

  /** A conditional world write: refused when the voxel changed or a unit, falling body or fragment is in the way. */
  private editIf(pos: Vec3, expected: number, value: number, commit?: () => void): boolean {
    if (this.store.getVoxel(...pos) !== expected || this.collapse.overlaps(...pos) || this.registry.solid[voxelId(value)] && (this.workers?.overlaps(...pos) || this.gravity.occupies(...pos))) return false
    this.store.prepareChunks([this.layout.chunkOf(...pos)])
    // Neighbours whose mesh the edit changes move their version too, so the view's barrier waits for their new mesh.
    this.store.touchChunks(this.layout.chunksAround(...pos))
    this.applySet(...pos, value, true, commit); return true
  }

  /** A worker unit's body, a falling block or a structural fragment is in the cell (the bodies editIf refuses a solid onto). */
  private occupied(x: number, y: number, z: number): boolean {
    return this.layout.inBounds(x, y, z) && ((this.workers?.overlaps(x, y, z) ?? false) || this.gravity.occupies(x, y, z) || this.collapse.overlaps(x, y, z))
  }

  get pendingWork(): number { return this.neighbors.length - this.neighborHead + this.scheduler.size }

  /** True while physics (gravity, water, region jobs) is stopped. Rules, random ticks, light and the water mirror still run. */
  get paused(): boolean { return this.isPaused }
  setPaused(paused: boolean): void { this.isPaused = paused }

  submit(clientId: number, seq: number, cmd: Command): void {
    this.pending.push({ tick: this.tick, clientId, seq, cmd })
  }

  /** Hands the generator its document (GeneratorModule.configure). Throws if the generator rejects it. */
  configure(gen: GeneratorModule, doc: unknown): void {
    const r = gen.configure?.(doc, { size: this.layout.size, seed: this.seed, id: (name) => this.registry.id(name) })
    const sea = r && typeof r === 'object' ? r.seaLevel : undefined
    this.water.setSeaLevel(Number.isInteger(sea) && (sea as number) > 0 ? (sea as number) : 0)
    this.setVoid(r !== undefined && r !== null && typeof r === 'object' && r.void === true)
  }

  /** True when the generator declared a void world (spec §3): the bottom of the volume is a sink. */
  get voidWorld(): boolean { return this.isVoid }
  private setVoid(v: boolean): void {
    this.isVoid = v
    this.water.cols.drainFloor = v
    this.gravity.voidFloor = v
    this.collapse.voidFloor = v
    this.workers?.setVoid(v)
  }

  /** Runs the generator for chunk column (cx, cz) into `column` (32 × 32 × height voxels, cleared to air first). */
  generateColumnData(gen: GeneratorModule, cx: number, cz: number, column: Uint16Array): void {
    column.fill(AIR)
    gen.generateColumn(makeColumnContext(this.seed, this.layout.size[1], (name) => this.registry.id(name), column), cx, cz)
  }

  /** Writes a generated column into the world. Chunks stay open until finishGenerate or replaceColumns commits. */
  applyColumn(cx: number, cz: number, column: Uint16Array): void {
    if (this.workers && (this.workers.units.size || this.workers.nav.cacheTiles || this.workers.nav.regions.size || this.workers.nav.pending)) this.workers.invalidateAll()
    const L = this.layout
    if (column.length !== 32 * 32 * L.size[1]) throw new RangeError(`column has ${column.length} voxels, expected ${32 * 32 * L.size[1]}`)
    for (let cy = 0; cy < L.cy; cy++) {
      const ci = L.chunkIndex(cx, cy, cz), data = column.subarray(cy * 32768, (cy + 1) * 32768)
      this.store.writeChunkDense(ci, data)
      this.collapse.replaceChunk(ci, data, true)
    }
  }

  /** After every column is applied: the initial light pass, then commit. Returns every chunk index. */
  finishGenerate(): number[] {
    // No commit between the dense writes and initialize(): initialize writes slots directly and
    // relies on generation having left those chunks open. Commit after, so every version is even.
    this.light.initialize()
    this.store.commit()
    this.water.rebuild()
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
    const writes: { ci: number; data: Uint16Array; geometry: boolean }[] = []
    const masks = new Map<number, number>()
    const regenerated: [number, number][] = []
    let cx0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cz1 = -Infinity
    for (const c of cols) {
      if (this.workers?.columnOverlaps(c.cx, c.cz, c.data)) throw new FragmentOverlapError('regeneration overlaps a unit')
      if (this.collapse.overlapsColumn(c.cx, c.cz)) throw new FragmentOverlapError('regeneration overlaps a falling structural fragment')
      if (c.data.length !== CHUNK_VOLUME * L.cy) throw new RangeError(`column has ${c.data.length} voxels, expected ${CHUNK_VOLUME * L.cy}`)
      for (let cy = 0; cy < L.cy; cy++) {
        const ci = L.chunkIndex(c.cx, cy, c.cz)
        const data = c.data.subarray(cy * CHUNK_VOLUME, (cy + 1) * CHUNK_VOLUME)
        const old = store.readVoxels(ci, vox)
        const m = diffMask(old, data)
        if (m === 0) continue
        masks.set(ci, m)
        writes.push({ ci, data, geometry: this.workers?.geometryChanged(old, data) ?? false })
        const last = regenerated[regenerated.length - 1]
        if (!last || last[0] !== c.cx || last[1] !== c.cz) regenerated.push([c.cx, c.cz])
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
    for (const w of writes) { store.writeChunkDense(w.ci, w.data); this.epochs[w.ci]!++; this.collapse.replaceChunk(w.ci, w.data); this.workers?.replaceChunk(w.ci, w.geometry) }
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
    // The water of the regenerated chunk columns, rebuilt now even while paused.
    this.water.rebuildChunkColumns(regenerated)
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
    this.gravity.landed = []
    const acks: Ack[] = []
    let publications: SystemPublication[] = []
    let dirtyChunks: number[] = []
    try {
      this.rng.reseed(hash32(this.seed, t))
      this.systems?.start()
      // 1. commands
      const cmds = this.pending.sort(compareStamped)
      this.pending = []
      for (const c of cmds) {
        // Commands arrive from postMessage, so the value may not be an object at all.
        const err = typeof c.cmd !== 'object' || c.cmd === null
          ? 'command must be an object'
          : validateCommand(c.cmd, this.layout, this.registry.count, this.commandTypes)
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
      if (!this.isPaused) this.workers?.beforePhysics()
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
      if (!this.isPaused) {
        this.physics('gravity', () => this.gravity.step()) // 3
        this.physics('water', () => this.water.step()) // 4
        this.physics('region jobs', () => this.jobs.run(this.jobCap)) // 5
        // Ownership transfers must fail fatally rather than continue with a partially applied fragment.
        this.collapse.step()
      }
      // 3. random ticks
      if (this.hasRandom) {
        this.randomTickPass()
        this.processNeighbors(budget)
      }
      // 4. light
      if (!this.isPaused) this.workers?.afterPhysics()
      // Game systems see this tick's unit results; what they ask of units acts in the next tick's unit step (spec §2).
      if (!this.isPaused) {
        const unitEvents = this.workers?.takeUnitEvents() ?? []
        if (this.systems) publications = this.systems.tick(unitEvents)
      }
      this.light.propagate()
      // 5. the water mirror follows the heightfield every tick, paused or not, so edits made while paused show
      this.physics('water mirror', () => { this.water.flush() })
    } finally {
      // 6. always close seqlocks, even if something above threw
      dirtyChunks = this.store.commit()
      this.tick = t + 1
    }
    const landed = this.gravity.landed
    for (const l of landed) l.version = this.store.versions[l.chunk]!
    const ws = this.water.stats(), jobs = this.jobs.size
    const physics = { waterTiles: ws.tiles, waterColumns: ws.columns, waterBodies: ws.bodies, waterLayersHidden: ws.layersHidden, jobs, busy: ws.tiles > 0 || jobs > 0 || this.gravity.count > 0 || this.collapse.busy || (this.workers?.busy ?? false),
      ...(this.collapse.enabled && { collapse: this.collapse.stats() }) }
    const events = this.events
    this.events = []
    const collapse = this.collapse.publication(this.store.versions)
    return { tick: t, dirtyChunks, events, acks, falling: this.gravity.snapshot(), landed, physics, water: this.water.published, ...(collapse && { collapse }), ...(this.workers && { workers: this.workers.publication(this.store.versions, t) }), ...(publications.length > 0 && { systems: publications }) }
  }

  /**
   * The state a save needs, taken between two ticks (spec §4–5): the regions whose revision differs from `since` (all when
   * null) and every section. Navigation, light and publication state are not included: restore() rebuilds them.
   */
  snapshot(since: Uint32Array | null): SimSnapshot {
    const t0 = performance.now()
    const revs = this.store.regionRevisions
    const regions: RegionBlob[] = []
    for (let r = 0; r < revs.length; r++) if (!since || since[r] !== revs[r]) regions.push({ r, bytes: encodeRegion(this.store, r) })
    const sections: SimSnapshot['sections'] = [
      { name: 'scheduler', bytes: pack(this.schedulerState()) },
      { name: 'water', bytes: pack(this.water.snapshot()) },
      { name: 'gravity', bytes: pack(this.gravity.saveState()) },
      { name: 'collapse', bytes: pack(this.collapse.snapshot()) },
      ...(this.workers ? [{ name: 'workers' as const, bytes: pack({ json: this.workers.snapshot(), arrays: {} }) }] : []),
      ...(this.systems?.snapshot() ?? []),
    ]
    return { tick: this.tick, paused: this.isPaused, revisions: revs.slice(), regions, sections, ms: performance.now() - t0 }
  }

  /**
   * Boots this (fresh, configured, never generated) simulation from a save instead of generate(): fills every chunk,
   * relights, rebuilds water from the voxels, then restores each section over it. Returns every chunk index.
   */
  restore(s: SimRestore): number[] {
    // Without game systems, a save that has system sections is refused (with them, SystemRunner.restore checks them).
    if (!this.systems) refuseSystemSections(s.sections)
    const scratch = new Uint16Array(CHUNK_VOLUME)
    for (const { r, bytes } of s.regions) decodeRegion(bytes, this.layout, r, (ci, data) => {
      const vox = typeof data === 'number' ? scratch.fill(data) : data
      this.store.writeChunkDense(ci, vox)
      this.collapse.replaceChunk(ci, vox, true)
    })
    const chunks = this.finishGenerate()
    this.tick = s.tick
    this.isPaused = s.paused
    const section = (name: SectionName): Packed | null => { const b = s.sections[name]; return b ? unpack(b) : null }
    const sched = section('scheduler')
    if (sched) {
      this.scheduler.restore(sched.arrays.pairs as Int32Array, (sched.json as { seq: number }).seq)
      this.neighbors = [...(sched.arrays.neighbors as Int32Array)]
      this.neighborHead = 0
    }
    const water = section('water')
    if (water) this.water.restore(water)
    const gravity = section('gravity')
    if (gravity) this.gravity.restoreState(gravity)
    const collapse = section('collapse')
    if (collapse) this.collapse.restore(collapse)
    const workers = section('workers')
    if (workers && !this.workers) throw new Error('the save has worker units but this simulation runs without workers')
    if (workers) this.workers!.restore(workers.json as WorkersSnapshot)
    // Game systems: refused (fatal at boot) when a system section is missing, unknown or of another version (plan D2).
    this.systems?.restore(s.sections)
    this.store.regionRevisions.fill(0)
    return chunks
  }

  private schedulerState(): Packed {
    const { pairs, seq } = this.scheduler.entries()
    return { json: { seq }, arrays: { pairs, neighbors: Int32Array.from(this.neighbors.slice(this.neighborHead)) } }
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
    mix(this.isPaused ? 1 : 0)
    if (this.isVoid) mix(0x766f6964) // only void worlds mix it, so other worlds hash as before
    this.gravity.mixState(mix)
    this.water.mixState(mix)
    this.jobs.mixState(mix)
    this.collapse.mixState(mix)
    this.workers?.mixState(mix)
    this.systems?.mixState(mix)
    return h >>> 0
  }

  /** Spec §9: a physics exception is a bug, not content. Log it, finish the tick, heal the water through a rebuild. */
  private physics(name: string, fn: () => void): void {
    try {
      fn()
    } catch (e) {
      if (e instanceof WorldFullError) throw e
      this.log(`${name} error tick=${this.tick}: ${e instanceof Error ? e.message : String(e)}`)
      if (name !== 'gravity') this.water.needsRebuild = true
    }
  }

  private applyCommand(cmd: Command): void {
    if (this.systems?.owns(cmd.type)) { this.systems.command(cmd); return }
    if (WORKER_COMMANDS.has(cmd.type) && this.workers) { this.workers.command(cmd); return }
    if (cmd.type === 'setBlock') {
      const c = cmd as SetBlockCommand
      if (this.registry.solid[voxelId(c.voxel)] && this.workers?.overlaps(...c.pos)) throw new Error('edit overlaps a unit')
      this.applySet(c.pos[0], c.pos[1], c.pos[2], c.voxel, true)
      return
    }
    if (cmd.type === 'fillRegion') {
      const c = cmd as FillRegionCommand
      const [x0, y0, z0] = c.min, [x1, y1, z1] = c.max
      if (this.registry.solid[voxelId(c.voxel)] && this.workers?.overlapsRegion(c.min, c.max)) throw new Error('fill overlaps a unit')
      // Preflight the whole command so a rejected fill has no partial effect.
      if (this.collapse.stats().fragments) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        if (this.collapse.overlaps(x, y, z)) throw new FragmentOverlapError('edit overlaps a falling structural fragment')
      }
      for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
        const shell = x === x0 || x === x1 || y === y0 || y === y1 || z === z0 || z === z1
        this.applySet(x, y, z, c.voxel, shell)
      }
      return
    }
    this.handlers.get(cmd.type)!(this.ctx, cmd)
  }

  private applySet(x: number, y: number, z: number, v: number, notify: boolean, onCommit?: () => void): void {
    const old = this.store.getVoxel(x, y, z)
    if (old === v || !this.layout.inBounds(x, y, z)) return
    if (!this.collapseWrite && this.collapse.overlaps(x, y, z)) throw new FragmentOverlapError('edit overlaps a falling structural fragment')
    if (!this.store.setVoxel(x, y, z, v)) return
    onCommit?.()
    this.workers?.afterWrite(x, y, z, old, v)
    this.epochs[this.layout.chunkOf(x, y, z)]!++
    // Light depends only on a block's opacity and emission, which belong to its id: a state change cannot move it.
    if (voxelId(old) !== voxelId(v)) this.light.onVoxelChanged(x, y, z, old, v)
    this.water.onWrite(x, y, z, old, v)
    this.gravity.afterWrite(x, y, z, v)
    this.collapse.afterWrite(x, y, z, old, v)
    if (!notify || !this.hasNeighborRules) return
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

  /**
   * randomTicksPerChunk samples in every slot chunk (uniform chunks hold one block everywhere and are
   * skipped). Each sample reads its slot directly and only builds coordinates for a block with an
   * onRandomTick rule; the draws (and so the rule calls) are the same as sampling through runAt.
   */
  private randomTickPass(): void {
    const L = this.layout, store = this.store, rule = this.randomRule, n = this.randomTicks
    const layer = L.cx * L.cz
    for (let ci = 0; ci < L.chunkCount; ci++) {
      const slot = store.slotOf(ci)
      if (slot < 0) continue
      // A slot keeps its array for the whole tick: rule writes may open chunks, but only commit() collapses one.
      const vox = store.views.voxels(slot)
      let x0 = -1, y0 = 0, z0 = 0
      for (let k = 0; k < n; k++) {
        const local = this.rng.nextInt(32768)
        const v = vox[local]!
        if (rule[voxelId(v)] !== 1) continue
        if (x0 < 0) {
          const cy = Math.floor(ci / layer), rest = ci - cy * layer, cz = Math.floor(rest / L.cx)
          x0 = (rest - cz * L.cx) * 32; y0 = cy * 32; z0 = cz * 32
        }
        this.callRule(this.byId[voxelId(v)]!.onRandomTick!, x0 + (local & 31), y0 + (local >> 10), z0 + ((local >> 5) & 31), v)
      }
    }
  }

  private runAt(pos: number, hook: keyof BlockRules): void {
    const [x, y, z] = this.layout.voxelCoords(pos)
    const v = this.store.getVoxel(x, y, z)
    const fn: BlockCallback | undefined = this.byId[voxelId(v)]?.[hook]
    if (!fn) return
    this.callRule(fn, x, y, z, v)
  }

  /** Runs one rule callback; an exception is logged (WorldFullError is fatal and rethrown). */
  private callRule(fn: BlockCallback, x: number, y: number, z: number, v: number): void {
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

  private makeSystemContext(rng: Pcg32, runner: SystemRunner): SystemContext {
    const sim = this
    const noUnits = () => { throw new Error('this simulation runs without worker units') }
    const units: SystemUnits = sim.workers ? {
      get events() { return runner.events },
      spawn: (pos) => sim.workers!.spawnControlled(pos),
      despawn: (id) => sim.workers!.despawnControlled(id),
      goTo: (id, pos) => sim.workers!.goTo(id, pos),
      dig: (id, pos) => sim.workers!.work(id, 'dig', pos),
      build: (id, pos, voxel) => sim.workers!.work(id, 'build', pos, voxel),
      stop: (id) => sim.workers!.stop(id),
      setWorkSpeed: (id, speed) => sim.workers!.setWorkSpeed(id, speed),
      view: (id) => sim.workers!.view(id),
    } : { events: [], spawn: noUnits, despawn: noUnits, goTo: noUnits, dig: noUnits, build: noUnits, stop: noUnits, setWorkSpeed: noUnits, view: noUnits }
    return {
      get tick() { return sim.tick },
      layout: sim.layout,
      random: () => rng.next(),
      id: (name) => sim.registry.id(name),
      get: (x, y, z) => sim.store.getVoxel(x, y, z),
      isSolid: (v) => sim.registry.solid[voxelId(v)] === 1,
      isLiquid: (v) => sim.registry.liquid[voxelId(v)] === 1,
      falls: (v) => sim.registry.falls[voxelId(v)] === 1,
      skyLight: (x, y, z) => skyLight(sim.store.getLight(x, y, z)),
      blockLight: (x, y, z) => blockLight(sim.store.getLight(x, y, z)),
      waterDepth: (x, y, z) => sim.water.depthAt(x, y, z),
      takeWater: (x, y, z, amount) => sim.water.take(x, y, z, amount),
      occupied: (x, y, z) => sim.occupied(x, y, z),
      edit: (pos, expected, value) => {
        if (!sim.layout.inBounds(...pos)) throw new RangeError(`edit outside the world: [${pos.join(', ')}]`)
        if (!Number.isInteger(value) || value < 0 || value > 0xffff || voxelId(value) >= sim.registry.count) throw new Error(`invalid voxel ${value}`)
        return sim.editIf(pos, expected, value)
      },
      emit: (type, payload) => { sim.events.push(payload === undefined ? { tick: sim.tick, type } : { tick: sim.tick, type, payload }) },
      units,
    }
  }

  private makeContext(): RuleContext {
    const sim = this
    const size = Object.freeze([...sim.layout.size] as [number, number, number])
    return {
      get tick() { return sim.tick },
      size,
      get: (x, y, z) => sim.store.getVoxel(x, y, z),
      set: (x, y, z, v) => {
        if (!Number.isInteger(v) || v < 0 || v > 0xffff || voxelId(v) >= sim.registry.count) throw new Error(`invalid voxel ${v}`)
        sim.applySet(x, y, z, v, true)
      },
      occupied: (x, y, z) => sim.occupied(x, y, z),
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
      isSolid: (v) => sim.registry.solid[voxelId(v)] === 1,
      isLiquid: (v) => sim.registry.liquid[voxelId(v)] === 1,
      isOpaque: (v) => sim.registry.opaque[voxelId(v)] === 1,
      falls: (v) => sim.registry.falls[voxelId(v)] === 1,
      skyLight: (x, y, z) => skyLight(sim.store.getLight(x, y, z)),
      blockLight: (x, y, z) => blockLight(sim.store.getLight(x, y, z)),
      level: (v) => {
        const id = voxelId(v)
        if (sim.registry.liquid[id] !== 1) return -1
        return sim.registry.source[id] === 1 ? 7 : voxelState(v) & 7
      },
    }
  }
}
