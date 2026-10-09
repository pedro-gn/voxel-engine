import * as THREE from 'three/webgpu'
import { BlockRegistry, type BlockDef } from './blocks/registry.ts'
import { columnTop, ghostAwareGet, markTick } from './engineWorld.ts'
import { EngineError, showErrorScreen } from './errors.ts'
import { GhostEdits } from './interact/ghostEdits.ts'
import { OrbitCamera } from './interact/orbitCamera.ts'
import { raycast, type RayHit, type Vec3Like } from './interact/raycast.ts'
import { DecorationRegistry, type DecorationDef } from './render/decorations/defs.ts'
import { meshTablesFrom } from './mesh/tables.ts'
import type { FromMesh, FromSim, GenConnect, SimInitOptions, TerrainRect, ToMesh, ToSim } from './protocol.ts'
import { columnsIn } from './sim/simHost.ts'
import type { AtmosphereController } from './render/atmosphere.ts'
import type { Effects, Quality, WaterInput, WaterParams } from './render/settings.ts'
import { Visuals } from './render/visuals.ts'
import { FallingTrack } from './render/fallingTrack.ts'
import { FragmentTrack } from './render/fragmentTrack.ts'
import type { ChunkMeshData } from './mesh/mesher.ts'
import { SimClock, stepAlpha } from './render/simClock.ts'
import { SurfaceMirror } from './render/water/surfaceMirror.ts'
import { WaterHost, type WaterReply } from './render/water/waterHost.ts'
import { WaterLink } from './render/water/waterLink.ts'
import type { ToWater } from './render/water/water.worker.ts'
import { CostMeter } from './render/costMeter.ts'
import { MeshQueue, PRIORITY } from './render/meshQueue.ts'
import { buildTextureArray } from './render/textureArray.ts'
import { TILE, checkTextureScale, checkTileSize, layerScales } from './render/tiles.ts'
import { validateCommand, type Ack, type Command, type FillRegionCommand, type SetBlockCommand } from './sim/commands.ts'
import type { SimEvent } from './sim/simulation.ts'
import type { WorkerStats, WorkerTick } from './sim/workers/types.ts'
import { createWorldBuffers } from './world/buffers.ts'
import { Layout, type WorldSize } from './world/layout.ts'
import { WorldReader } from './world/reader.ts'
import { voxelId } from './world/voxel.ts'

export interface EngineOptions {
  canvas: HTMLCanvasElement
  size?: WorldSize
  seed: number
  blocks: BlockDef[]
  decorations?: DecorationDef[]
  textures: Record<string, string>
  simWorker: () => Worker
  sim?: SimInitOptions
  meshWorkers?: number
  forceWebGL?: boolean
  /** Opt-in GPU timestamp queries (WebGPU; sampled every 30 frames). Default false. */
  gpuTiming?: boolean
  /** Texture tile resolution in texels: a power of two in [16, 1024]. Every texture is resized to it. Default 64. */
  tileSize?: number
  /** Texture name → how many blocks one repeat of it spans (default 1). Use > 1 for large painted textures that would otherwise repeat on every block. */
  textureScale?: Record<string, number>
  /** A terrain document for the generator (structured-cloneable, e.g. parsed JSON). Passed to its configure(). */
  terrain?: unknown
  /**
   * Starts a generation worker, e.g. `() => new Worker(new URL('./gen.worker.ts', import.meta.url), { type: 'module' })`
   * running `runGenWorker` with the sim's generator. With it, (re)generation runs in parallel; without it, the sim generates serially.
   */
  genWorker?: () => Worker
  /** Generation workers to start. Default: the mesh worker count. */
  genWorkers?: number
  /**
   * Draw the opaque and cutout chunk layers with one BatchedMesh per 4 × 4-chunk region instead of one mesh per chunk
   * (far fewer render objects, less CPU per frame). Same picture either way. Default true.
   */
  batchChunks?: boolean
  /**
   * Apply the water publishes in a dedicated worker (4a-r2 #2): the main thread only copies changed rows. False: the same
   * host runs in-thread, the A of the A/B. Default true.
   */
  waterWorker?: boolean
}

export interface EngineEvents {
  workers: WorkerTick
  frame: { dt: number; now: number }
  ready: { chunks: number }
  tick: { tick: number; tickMs: number }
  event: SimEvent
  ack: Ack
  log: { message: string }
  /** `slots` is set when the world ran out of slot pages. */
  fatal: { message: string; slots?: number }
  /** A regeneration finished: wall time from request to the new voxels being in the world, and chunk columns rebuilt. */
  generated: { ms: number; columns: number }
}

export interface EngineStats {
  workers?: WorkerStats
  fps: number; frameMs: number; tick: number; tickMs: number
  /** meshInFlight: chunks being meshed or meshed but not yet uploaded; queue + inFlight = 0 means everything is visible. */
  meshQueue: number; meshInFlight: number; failedChunks: number
  slotsUsed: number; meshes: number; drawCalls: number; backend: 'webgpu' | 'webgl'
  shadowCasters: number
  decorationInstances: number; decorationDraws: number
  /** Falling blocks being drawn (in the air or waiting for their chunk mesh). */
  fallingBodies: number
  /** Structural checks pending and fragments/cells currently in motion. */
  collapseChecks: number; collapseFragments: number; collapseCells: number
  collapseVisited: number; collapseMutations: number
  /** Awake water tiles (16 × 16 columns), wet columns in them, and queued region jobs, as of the last tick. */
  waterTiles: number; waterColumns: number; regionJobs: number
  /** Water bodies with a boundary in an awake tile, as of the last tick. */
  waterBodies: number
  /** Wet segments ranked past the 4 draw layers (not drawn), as of the last tick. */
  waterLayersHidden: number
  /** True while a water tile was awake, a region job queued or a block falling after the last tick. */
  physicsBusy: boolean
  /**
   * Main-thread cost (ms) of a water publish: the copy of the host's reply, plus the host's own cost when it runs in-thread.
   * The last one and the p95 of the last 200.
   */
  waterApplyMs: number; waterApplyP95: number
  /** GPU render time in ms; null when not tracked or unsupported. */
  gpuMs: number | null
  /** The water host's cost (ms) per request (apply + relights + packing), in the worker or in-thread: last and p95. */
  waterHostMs: number; waterHostP95: number
  /** From a tick message's arrival to the first frame that draws its water step (ms), queue wait included: last and p95. */
  waterLagMs: number; waterLagP95: number
  /** Water requests in flight or queued, now and the most over the last 200 ticks. */
  waterQueue: number; waterQueueMax: number
  /** Whether the water host runs in a worker (EngineOptions.waterWorker). */
  waterInWorker: boolean
}

export interface Engine {
  readonly workers: WorkerTick | null
  meshVersion(chunk: number): number
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly renderer: THREE.WebGPURenderer
  readonly blocks: BlockRegistry
  readonly layout: Layout
  readonly controls: OrbitCamera
  readonly atmosphere: AtmosphereController
  get quality(): Quality
  set quality(value: Partial<Quality>)
  get effects(): Effects
  set effects(value: Partial<Effects>)
  get water(): WaterParams
  set water(value: WaterInput)
  readonly world: { get(x: number, y: number, z: number): number; getLight(x: number, y: number, z: number): number }
  readonly terrain: {
    /** The initial generation: wall time (light pass included) and chunk columns. */
    readonly initial: { ms: number; columns: number }
    /** Hands the generator a new document. Rejects with EngineError 'terrain' if it refuses it; the world changes only on regenerate(). */
    setDocument(doc: unknown): Promise<void>
    /** Applies an incremental change to the generator's document (the generator's patch). Rejects with EngineError 'terrain' if it refuses it; the world changes only on regenerate(). */
    patch(patch: unknown): Promise<void>
    /** Regenerates the chunk columns overlapping `rect`; resolves once the new voxels and light are in the world. */
    regenerate(rect: TerrainRect): Promise<{ ms: number; chunks: number }>
  }
  /** Physics (falling blocks, water, region jobs). Paused, the world only changes through commands, rules and regeneration. */
  readonly physics: {
    readonly paused: boolean
    setPaused(paused: boolean): void
  }
  submit(cmd: Command): number
  raycast(origin: Vec3Like, dir: Vec3Like, maxDist?: number): RayHit | null
  pickScreen(clientX: number, clientY: number, maxDist?: number): RayHit | null
  setHighlight(pos: readonly [number, number, number] | null): void
  on<K extends keyof EngineEvents>(type: K, fn: (e: EngineEvents[K]) => void): () => void
  stats(): EngineStats
  dispose(): void
}

const CLIENT_ID = 0
const UPLOAD_BUDGET_MS = 4
/** Default ray length for picking: beyond the orbit camera's 400 max distance plus the default world's extent. */
const PICK_DISTANCE = 1024
/** Per chunk: failed jobs (error or crash) before it keeps its last mesh. */
const MAX_FAILURES = 3
/** Per pool slot: consecutive worker crashes before the engine gives up. */
const MAX_WORKER_CRASHES = 3
const NO_CUSTOM_COMMANDS: ReadonlySet<string> = new Set()
/** @internal The water worker crash hook's key (see the end of createEngine). */
const WATER_CRASH = Symbol.for('elovox.waterCrash')

class Emitter<E> {
  private readonly fns = new Map<keyof E, Set<(e: never) => void>>()
  on<K extends keyof E>(type: K, fn: (e: E[K]) => void): () => void {
    let set = this.fns.get(type)
    if (!set) { set = new Set(); this.fns.set(type, set) }
    set.add(fn as (e: never) => void)
    return () => { set!.delete(fn as (e: never) => void) }
  }
  emit<K extends keyof E>(type: K, e: E[K]): void {
    for (const fn of this.fns.get(type) ?? []) {
      try { (fn as (e: E[K]) => void)(e) } catch (err) { console.error(`[elovox] '${String(type)}' listener threw:`, err) }
    }
  }
}

interface PoolSlot { worker: Worker; jobs: { id: number; chunk: number }[]; crashes: number }
/**
 * Mesh jobs each worker holds at once. The main thread spends most of a frame rendering and only hands out
 * jobs between frames, so with one job per worker the pool meshed one chunk per worker per frame however
 * fast the jobs were. A queue keeps every worker busy through the frame. 8 drains a 128² terrain edit (~90 chunks,
 * 6 workers) in 3 frames; a deeper queue only delays a player edit queued behind a large remesh.
 */
const MESH_JOBS_PER_WORKER = 8
type MeshResult = Extract<FromMesh, { type: 'result' }>

export async function createEngine(o: EngineOptions): Promise<Engine> {
  const { canvas } = o
  if (!globalThis.crossOriginIsolated) {
    showErrorScreen(canvas, 'Cross-origin isolation is off',
      'Elovox needs SharedArrayBuffer. Serve the page with "Cross-Origin-Opener-Policy: same-origin" and ' +
      '"Cross-Origin-Embedder-Policy: require-corp" (see apps/sandbox/vite.config.ts).')
    throw new EngineError('not-isolated', 'COOP/COEP headers missing: crossOriginIsolated is false')
  }

  const size: WorldSize = o.size ?? [1024, 128, 1024]
  const layout = new Layout(size)
  const registry = new BlockRegistry(o.blocks)
  const decorations = new DecorationRegistry(o.decorations ?? [], registry)
  const tileSize = checkTileSize(o.tileSize ?? TILE)
  const textureScale = checkTextureScale(o.textureScale, registry.textureNames())
  const buffers = createWorldBuffers(size)
  const reader = new WorldReader(buffers, registry.opaque)
  const ghosts = new GhostEdits(layout)
  const queue = new MeshQueue()
  const tickMs = 1000 / (o.sim?.tickHz ?? 20)
  /** The smoothed sim clock falling cubes and the water surface are drawn on (spec §5). */
  const clock = new SimClock(tickMs)
  const falling = new FallingTrack(tickMs, clock)
  const fragments = new FragmentTrack(clock)
  const stagedSources = new Map<number, ChunkMeshData>()
  // The water's draw data: copied from a WaterHost, in a worker or in-thread (4a-r2 #2). The host is made before the sim
  // starts, so it reads the first publish after generation, which lists every tile once.
  const surfaceMirror = new SurfaceMirror(size, buffers.water)
  const inWorker = o.waterWorker ?? true
  /** The sim tick of the last water publish applied: the surface moves from the step before it to it (stepAlpha). */
  let waterTick: number | null = null
  /** The waterAlpha on screen: an apply starts the new step from it, after which alpha 0 shows the same heights. */
  let waterShown = 1
  /** Per chunk column, the layers [lo, hi) of the dirty chunks in it (relightRanges' scratch). */
  const relightRange = new Map<number, [number, number]>()
  /** The light ranges [cc, y0, y1]* where the sim changed voxel light (dirty chunks): still water is not republished. */
  const relightRanges = (chunks: readonly number[]): number[] => {
    if (chunks.length === 0) return []
    for (const ci of chunks) {
      const [cx, cy, cz] = layout.chunkCoords(ci)
      const cc = cx + cz * surfaceMirror.cx, r = relightRange.get(cc)
      if (r) { r[0] = Math.min(r[0], cy * 32); r[1] = Math.max(r[1], cy * 32 + 32) } else relightRange.set(cc, [cy * 32, cy * 32 + 32])
    }
    const out: number[] = []
    for (const [cc, [lo, hi]] of relightRange) out.push(cc, lo, hi)
    relightRange.clear()
    return out
  }
  const waterApply = new CostMeter(200), waterHostCost = new CostMeter(200), waterLag = new CostMeter(200)
  /** The arrival times of the publishes applied since the last frame, which draws them first (waterLag: one sample each, queue wait included). */
  const lagFrom: number[] = []
  /** The in-thread host (waterWorker false); otherwise the worker (spawned with the pools) and its crash count. */
  const localHost = inWorker ? null : new WaterHost(size, buffers.water, (x, y, z) => reader.getLight(x, y, z), 1000 / tickMs, surfaceMirror.surfaces)
  let waterWorker: Worker | null = null, waterCrashes = 0
  const waterLink: WaterLink = new WaterLink({
    post: (req) => {
      if (localHost) waterLink.receive(localHost.handle(req))
      else waterWorker?.postMessage(req satisfies ToWater)
    },
    copy: (reply, publish) => {
      const t0 = performance.now()
      surfaceMirror.copy(reply)
      waterHostCost.record(reply.hostMs)
      if (publish) waterApply.record(performance.now() - t0 + (localHost ? reply.hostMs : 0))
    },
    applied: (tick, arrived) => { waterTick = tick; waterShown = 0; clock.hold(surfaceMirror, tick + 1); lagFrom.push(arrived) },
    settled: () => clock.hold(surfaceMirror, null), // every tile settled (prev = cur): nothing to time
    shown: () => waterShown,
  })
  const events = new Emitter<EngineEvents>()
  const pages: SharedArrayBuffer[] = []

  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: o.forceWebGL ?? false, trackTimestamp: o.gpuTiming ?? false })
  try {
    await renderer.init()
  } catch (err) {
    showErrorScreen(canvas, 'No WebGPU or WebGL2', `This browser could not create a GPU context: ${String(err)}`)
    throw new EngineError('no-gpu', String(err))
  }
  const backend: 'webgpu' | 'webgl' = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl'
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 3000)
  const resize = () => {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }
  resize()
  const ro = new ResizeObserver(resize)
  ro.observe(canvas)

  const tex = await buildTextureArray(o.textures, registry.textureNames(), tileSize)
  tex.texture.anisotropy = renderer.getMaxAnisotropy()
  const faceLayers = registry.faceLayers(tex.layerOf)
  const tables = meshTablesFrom(registry, faceLayers, decorations.tables)
  const highlight = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.004, 1.004, 1.004)),
    new THREE.LineBasicNodeMaterial({ color: 0x1b1f24 }),
  )
  highlight.visible = false
  scene.add(highlight)

  const world = {
    get: ghostAwareGet(ghosts, (x, y, z) => reader.get(x, y, z)),
    getLight: (x: number, y: number, z: number) => reader.getLight(x, y, z),
  }
  const controls = new OrbitCamera({ worldSize: size, heightAt: (x, z) => columnTop(world.get, registry.solid, size, x, z) })
  const detachControls = controls.attach(canvas)
  const visuals = new Visuals({
    renderer, scene, camera, backend, texture: tex.texture, layout, registry,
    textureScales: layerScales(tex.layerOf, tex.texture.image.depth, textureScale),
    viewDistance: () => controls.current.distance,
    decorations,
    faceLayers,
    water: surfaceMirror,
    batchChunks: o.batchChunks ?? true,
  })

  // ---- lifecycle ----
  // No await between here and `await ready`, so an early rejection always has a handler.
  let resolveReady!: (chunks: number) => void
  let rejectReady!: (err: EngineError) => void
  const ready = new Promise<number>((res, rej) => { resolveReady = res; rejectReady = rej })
  const sim = o.simWorker()
  const pool: PoolSlot[] = []
  const genWorkers: Worker[] = []
  let halted = false
  let fatal: string | null = null
  let generated = false
  let initialGen = { ms: 0, columns: 0 }
  let terrainSeq = 0
  const terrainWaits = new Map<number, { resolve: (v: never) => void; reject: (e: EngineError) => void; columns: number }>()
  /** Stops ticking, meshing and rendering. GPU resources stay until dispose(). */
  const halt = () => {
    if (halted) return
    halted = true
    renderer.setAnimationLoop(null)
    sim.terminate()
    waterWorker?.terminate()
    for (const s of pool) s.worker.terminate()
    for (const w of genWorkers) w.terminate()
  }
  /** Rejects every pending terrain request and forgets it. */
  const rejectTerrainWaits = (message: string) => {
    for (const w of terrainWaits.values()) w.reject(new EngineError('fatal', message))
    terrainWaits.clear()
  }
  const fail = (message: string, slots?: number) => {
    if (fatal !== null) return
    fatal = message
    halt()
    console.error(`[elovox] fatal: ${message}`)
    events.emit('fatal', slots === undefined ? { message } : { message, slots })
    showErrorScreen(canvas, 'The engine stopped', message)
    rejectReady(new EngineError('fatal', message))
    rejectTerrainWaits(message)
  }

  // ---- mesh worker pool ----
  const results: MeshResult[] = []
  const failures = new Map<number, number>()
  const failed = new Set<number>()
  let jobId = 0

  const markDirty = (ci: number, priority: number) => {
    if (failed.delete(ci)) failures.delete(ci)
    queue.mark(ci, priority)
  }
  /** A job errored or its worker crashed: requeue the chunk, or after MAX_FAILURES keep its last mesh. */
  const jobFailed = (ci: number, message: string) => {
    const n = (failures.get(ci) ?? 0) + 1
    failures.set(ci, n)
    if (n < MAX_FAILURES) { queue.retry(ci); return }
    queue.finish(ci)
    failed.add(ci)
    console.error(`[elovox] chunk ${ci} failed to mesh ${n} times; keeping its last mesh. ${message}`)
  }
  const onMeshMessage = (slot: PoolSlot, m: FromMesh) => {
    slot.jobs = slot.jobs.filter((j) => j.id !== m.id)
    slot.crashes = 0 // the worker is alive and answering
    if (m.type === 'result') {
      queue.finish(m.chunk)
      failures.delete(m.chunk)
      failed.delete(m.chunk)
      results.push(m)
    } else if (m.type === 'retry') {
      queue.retry(m.chunk, true)
    } else {
      jobFailed(m.chunk, m.message)
    }
    dispatch() // top the worker's queue up now rather than at the next frame
  }
  const spawn = (i: number, crashes: number) => {
    if (halted) return
    const worker = new Worker(new URL('./mesh/mesh.worker.ts', import.meta.url), { type: 'module' })
    const slot: PoolSlot = { worker, jobs: [], crashes }
    worker.onmessage = (e: MessageEvent<FromMesh>) => onMeshMessage(slot, e.data)
    worker.onerror = (e) => {
      e.preventDefault()
      worker.terminate()
      const reason = e.message || 'the worker failed to load or crashed'
      const jobs = slot.jobs
      slot.jobs = []
      for (const job of jobs) jobFailed(job.chunk, `mesh worker crashed: ${reason}`)
      if (slot.crashes + 1 >= MAX_WORKER_CRASHES) fail(`mesh worker keeps crashing: ${reason}`)
      else spawn(i, slot.crashes + 1)
    }
    worker.postMessage({ type: 'init', buffers, pages: [...pages], tables } satisfies ToMesh)
    pool[i] = slot
  }
  const poolSize = o.meshWorkers ?? Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 2))
  for (let i = 0; i < poolSize; i++) spawn(i, 0)

  // ---- water worker (4a-r2 #2) ----
  const spawnWater = (): Worker => {
    const worker = new Worker(new URL('./render/water/water.worker.ts', import.meta.url), { type: 'module' })
    const lost = (reason: string) => {
      worker.terminate()
      if (halted || waterWorker !== worker) return
      // One respawn: the new view starts empty and the sim republishes every tile (spec 4.5). A second loss is fatal.
      if (++waterCrashes >= 2) { fail(`water worker crashed twice: ${reason}`); return }
      console.error(`[elovox] water worker lost (${reason}); restarting it`)
      waterLink.reset()
      surfaceMirror.reset()
      waterWorker = spawnWater()
      sim.postMessage({ type: 'waterResync' } satisfies ToSim)
    }
    worker.onmessage = (e: MessageEvent<WaterReply>) => { if (waterWorker === worker) waterLink.receive(e.data) }
    worker.onerror = (e) => { e.preventDefault(); lost(e.message || 'the worker failed to load or crashed') }
    worker.onmessageerror = () => lost('the worker sent a message that could not be deserialized')
    worker.postMessage({ type: 'init', buffers, opaque: registry.opaque, pages: [...pages], stepHz: 1000 / tickMs, surfaces: surfaceMirror.surfaces } satisfies ToWater)
    return worker
  }
  if (inWorker) waterWorker = spawnWater()

  // ---- generation workers (optional) ----
  const genPorts: MessagePort[] = []
  if (o.genWorker) {
    const n = Math.max(1, o.genWorkers ?? poolSize)
    for (let i = 0; i < n; i++) {
      try {
        const worker = o.genWorker()
        const ch = new MessageChannel()
        worker.postMessage({ type: 'connect', port: ch.port2 } satisfies GenConnect, [ch.port2])
        const lost = (reason: string) => {
          worker.terminate()
          if (!generated) fail(`generation worker crashed: ${reason}`)
          else if (!halted) sim.postMessage({ type: 'genLost', index: i } satisfies ToSim)
        }
        worker.onerror = (e) => {
          e.preventDefault()
          lost(e.message || 'the worker failed to load or crashed')
        }
        worker.onmessageerror = () => lost('the worker sent a message that could not be deserialized')
        genWorkers.push(worker)
        genPorts.push(ch.port1)
      } catch (err) {
        // Startup failure: halt and reject `ready`, so createEngine cleans up instead of leaking the sim, pool and renderer.
        fail(`generation worker failed to start: ${err instanceof Error ? err.message : String(err)}`)
        break
      }
    }
  }

  // ---- sim worker ----
  let lastTick = 0, lastTickMs = 0, slotsUsed = 0
  let physicsStats: Extract<FromSim, { type: 'tick' }>['physics'] = { waterTiles: 0, waterColumns: 0, waterBodies: 0, waterLayersHidden: 0, jobs: 0, busy: false }
  sim.onmessage = (e: MessageEvent<FromSim>) => {
    const m = e.data
    switch (m.type) {
      case 'page':
        pages[m.index] = m.page
        reader.addPage(m.index, m.page)
        for (const s of pool) s.worker.postMessage({ type: 'page', index: m.index, page: m.page } satisfies ToMesh)
        waterWorker?.postMessage({ type: 'page', index: m.index, page: m.page } satisfies ToWater)
        break
      case 'ready':
        generated = true
        initialGen = { ms: m.genMs, columns: m.columns }
        slotsUsed = m.slotsUsed
        for (const ci of m.chunks) queue.mark(ci, PRIORITY.INITIAL)
        sim.postMessage({ type: 'start' } satisfies ToSim)
        events.emit('ready', { chunks: m.chunks.length })
        resolveReady(m.chunks.length)
        break
      case 'tick':
        lastTick = m.tick
        lastTickMs = m.tickMs
        slotsUsed = m.slotsUsed
        markTick(m, CLIENT_ID, ghosts, markDirty)
        falling.update(m.tick, m.falling, m.landed, performance.now())
        fragments.update(m.tick, m.collapse, performance.now())
        // While the water moves it holds the clock at the end of its step: a late publish holds it, nothing is extrapolated.
        // The host applies it, then the tick's relights; the link calls back applied/settled in tick order (spec 4.1).
        waterLink.submit(m.tick, m.water, relightRanges(m.dirtyChunks), true, performance.now())
        physicsStats = m.physics
        if (m.workers) { latestWorkers = m.workers; events.emit('workers', m.workers) }
        for (const a of m.acks) events.emit('ack', a)
        for (const ev of m.events) events.emit('event', ev)
        events.emit('tick', { tick: m.tick, tickMs: m.tickMs })
        break
      case 'terrain': {
        const w = terrainWaits.get(m.id)
        terrainWaits.delete(m.id)
        if (m.ok) w?.resolve(undefined as never)
        else w?.reject(new EngineError('terrain', m.message))
        break
      }
      case 'regenerated': {
        const w = terrainWaits.get(m.id)
        terrainWaits.delete(m.id)
        if (!m.ok) { w?.reject(new EngineError('terrain', m.message)); break }
        slotsUsed = m.slotsUsed
        for (const ci of m.dirtyChunks) markDirty(ci, PRIORITY.DIRTY)
        { const ranges = relightRanges(m.dirtyChunks); if (ranges.length > 0) waterLink.submit(-1, null, ranges, false, performance.now()) }
        events.emit('generated', { ms: m.ms, columns: w?.columns ?? 0 })
        w?.resolve({ ms: m.ms, chunks: m.dirtyChunks.length } as never)
        break
      }
      case 'log':
        console.info(`[elovox sim] ${m.message}`)
        events.emit('log', { message: m.message })
        break
      case 'fatal':
        fail(m.slots === undefined ? m.message : `${m.message} (${m.slots} slots in use)`, m.slots)
        break
    }
  }
  sim.onerror = (e) => {
    e.preventDefault()
    fail(`sim worker crashed: ${e.message || 'the worker failed to load or crashed'}`)
  }
  const init: Extract<ToSim, { type: 'init' }> = { type: 'init', buffers, blocks: o.blocks, seed: o.seed, options: o.sim ?? {}, terrain: o.terrain }
  if (genPorts.length > 0) init.genPorts = genPorts
  sim.postMessage(init, genPorts)

  // ---- frame loop ----
  const distanceTo = (ci: number) => {
    const [cx, cy, cz] = layout.chunkCoords(ci)
    const dx = cx * 32 + 16 - camera.position.x, dy = cy * 32 + 16 - camera.position.y, dz = cz * 32 + 16 - camera.position.z
    return dx * dx + dy * dy + dz * dz
  }
  function dispatch(): void {
    for (const slot of pool) while (slot.jobs.length < MESH_JOBS_PER_WORKER) {
      const ci = queue.next(distanceTo)
      if (ci < 0) return
      const overrides = ghosts.size > 0 ? ghosts.overridesFor(ci) : []
      const msg: ToMesh = overrides.length > 0
        ? { type: 'job', id: ++jobId, chunk: ci, overrides }
        : { type: 'job', id: ++jobId, chunk: ci }
      slot.jobs.push({ id: msg.id, chunk: ci })
      slot.worker.postMessage(msg)
    }
  }
  const upload = () => {
    // The budget measures Visuals.applyMesh CPU time only; the GPU upload happens later, inside renderer.render.
    const start = performance.now()
    while (results.length > 0 && performance.now() - start < UPLOAD_BUDGET_MS) {
      const r = results.shift()!
      if (queue.accept(r.chunk, r.version)) {
        if (fragments.holdsChunk(r.chunk) || stagedSources.has(r.chunk)) stagedSources.set(r.chunk, r.data)
        else visuals.applyMesh(r.chunk, r.data)
      }
    }
    // Replace all source meshes and show debris together; a partially updated multi-chunk source leaves holes.
    if (fragments.sourcesReady(ci => queue.appliedVersion(ci))) {
      for (const [ci, data] of stagedSources) visuals.applyMesh(ci, data)
      stagedSources.clear(); fragments.releaseSources()
    }
  }
  let latestWorkers: WorkerTick | null = null
  let last = performance.now(), fpsT = last, frames = 0, fps = 0, frameMs = 0
  let gpuMs: number | null = null, gpuFrames = 0
  renderer.setAnimationLoop(() => {
    const now = performance.now()
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    controls.update(dt)
    controls.apply(camera)
    queue.releaseRetries()
    dispatch()
    upload()
    // FallingTrack.frame advances the shared clock for this frame; the water reads it after.
    visuals.drawFalling(falling.frame(performance.now(), (ci) => queue.appliedVersion(ci)), (x, y, z) => reader.getLight(x, y, z))
    visuals.drawFragments(fragments.frame(performance.now(), ci => stagedSources.has(ci) ? -1 : queue.appliedVersion(ci)), (x, y, z) => reader.getLight(x, y, z))
    // A publish in the host is drawn at the alpha it was sent with until its copy (spec 4.1: freeze, not carry).
    waterShown = waterLink.frozen ?? (waterTick === null ? 1 : stepAlpha(clock.due, waterTick))
    for (const from of lagFrom) waterLag.record(now - from)
    lagFrom.length = 0
    visuals.setWaterAlpha(waterShown)
    // Before rendering, so listeners' scene changes show in this frame.
    events.emit('frame', { dt, now })
    visuals.frame(dt)
    if (o.gpuTiming && ++gpuFrames % 30 === 0) {
      renderer.resolveTimestampsAsync('render').then((ms) => { if (typeof ms === 'number') gpuMs = ms }).catch(() => {})
    }
    frameMs = performance.now() - now
    frames++
    if (now - fpsT >= 500) { fps = (frames * 1000) / (now - fpsT); frames = 0; fpsT = now }
  })

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    halt()
    rejectTerrainWaits('the engine was disposed')
    detachControls()
    ro.disconnect()
    scene.remove(highlight)
    visuals.dispose()
    highlight.geometry.dispose()
    highlight.material.dispose()
    tex.texture.dispose()
    renderer.dispose()
  }

  try {
    await ready
  } catch (err) {
    dispose()
    throw err
  }

  // ---- public API ----
  let seq = 0
  const pickable = (v: number) => { const id = voxelId(v); return id !== 0 && registry.liquid[id] === 0 }
  const rc = (origin: Vec3Like, dir: Vec3Like, maxDist = PICK_DISTANCE) => raycast(world.get, pickable, size, origin, dir, maxDist)
  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  /** Posts a terrain request and settles with the sim's answer. */
  const terrainRequest = <T>(msg: (id: number) => ToSim, columns = 0): Promise<T> => {
    if (halted) return Promise.reject(new EngineError('fatal', fatal ?? 'the engine is stopped'))
    const id = ++terrainSeq
    return new Promise<T>((resolve, reject) => {
      terrainWaits.set(id, { resolve: resolve as (v: never) => void, reject, columns })
      sim.postMessage(msg(id))
    })
  }

  let physicsPaused = o.sim?.paused === true
  const physics = {
    get paused() { return physicsPaused },
    setPaused(paused: boolean) {
      if (typeof paused !== 'boolean') throw new TypeError(`physics.setPaused expects a boolean, got ${typeof paused}`)
      physicsPaused = paused
      if (!halted) sim.postMessage({ type: 'setPaused', paused } satisfies ToSim)
    },
  }

  const api: Engine = {
    scene, camera, renderer, blocks: registry, layout, controls, world,
    terrain: {
      get initial() { return initialGen },
      setDocument: (doc) => terrainRequest<void>((id) => ({ type: 'setTerrain', id, doc })),
      patch: (patch) => terrainRequest<void>((id) => ({ type: 'patchTerrain', id, patch })),
      regenerate: (rect) => terrainRequest<{ ms: number; chunks: number }>(
        (id) => ({ type: 'regenerate', id, rect }),
        [rect.x0, rect.z0, rect.x1, rect.z1].every(Number.isInteger) && rect.x1 > rect.x0 && rect.z1 > rect.z0 ? columnsIn(rect).length : 0,
      ),
    },
    physics,
    get workers() { return latestWorkers },
    // A staged mesh is accepted but not drawn until its fragment sources release together.
    meshVersion: ci => stagedSources.has(ci) ? -1 : queue.appliedVersion(ci),
    atmosphere: visuals.atmosphere,
    get quality(): Quality { return visuals.getQuality() },
    set quality(value: Partial<Quality>) { visuals.setQuality(value) },
    get effects(): Effects { return visuals.getEffects() },
    set effects(value: Partial<Effects>) { visuals.setEffects(value) },
    get water(): WaterParams { return visuals.getWater() },
    set water(value: WaterInput) { visuals.setWater(value) },
    submit(cmd) {
      const s = ++seq
      if (halted) return s // stopped: there is no sim to ack it
      // Ghost only what the sim will accept, so a prediction is never left without an ack to clear it.
      if (cmd.type === 'setBlock' && validateCommand(cmd, layout, registry.count, NO_CUSTOM_COMMANDS) === null) {
        const c = cmd as SetBlockCommand
        visuals.noteEdit(c, world.get) // a block at the water line sends ripples over the water (before the ghost: world.get sees it)
        for (const ci of ghosts.add(s, c.pos[0], c.pos[1], c.pos[2], c.voxel)) markDirty(ci, PRIORITY.GHOST)
      } else if (cmd.type === 'fillRegion' && validateCommand(cmd, layout, registry.count, NO_CUSTOM_COMMANDS) === null) {
        visuals.noteEdit(cmd as FillRegionCommand, world.get)
      }
      sim.postMessage({ type: 'submit', clientId: CLIENT_ID, seq: s, cmd } satisfies ToSim)
      return s
    },
    raycast: rc,
    pickScreen(clientX, clientY, maxDist = PICK_DISTANCE) {
      const r = canvas.getBoundingClientRect()
      ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1)
      raycaster.setFromCamera(ndc, camera)
      return rc(raycaster.ray.origin, raycaster.ray.direction, maxDist)
    },
    setHighlight(pos) {
      highlight.visible = pos !== null
      if (pos) highlight.position.set(pos[0] + 0.5, pos[1] + 0.5, pos[2] + 0.5)
    },
    on: (type, fn) => events.on(type, fn),
    stats: () => {
      const vs = visuals.stats()
      return {
        fps, frameMs, tick: lastTick, tickMs: lastTickMs,
        meshQueue: queue.size, meshInFlight: queue.inFlightCount + results.length, failedChunks: failed.size,
        slotsUsed, meshes: visuals.chunks.meshCount, drawCalls: renderer.info.render.drawCalls, backend,
        shadowCasters: vs.shadowCasters, decorationInstances: vs.decorationInstances, decorationDraws: vs.decorationDraws, gpuMs,
        fallingBodies: falling.size, waterTiles: physicsStats.waterTiles, waterColumns: physicsStats.waterColumns, regionJobs: physicsStats.jobs, physicsBusy: physicsStats.busy,
        collapseChecks: physicsStats.collapse?.checks ?? 0, collapseFragments: physicsStats.collapse?.fragments ?? 0, collapseCells: physicsStats.collapse?.cells ?? 0,
        collapseVisited: physicsStats.collapse?.visited ?? 0, collapseMutations: physicsStats.collapse?.mutations ?? 0,
        waterBodies: physicsStats.waterBodies, waterLayersHidden: physicsStats.waterLayersHidden,
        waterApplyMs: waterApply.last, waterApplyP95: waterApply.p95(),
        waterHostMs: waterHostCost.last, waterHostP95: waterHostCost.p95(), waterLagMs: waterLag.last, waterLagP95: waterLag.p95(),
        waterQueue: waterLink.depth, waterQueueMax: waterLink.maxDepth(), waterInWorker: inWorker,
        ...(latestWorkers && { workers: latestWorkers.stats }),
      }
    },
    dispose,
  }
  // @internal, tests only: crashes the water worker through its error path (spec 4.5). Symbol-keyed and not on the Engine
  // type, so nothing public reaches it; e2e calls `engine[Symbol.for('elovox.waterCrash')]()`.
  Object.defineProperty(api, WATER_CRASH, { value: () => waterWorker?.dispatchEvent(new ErrorEvent('error', { message: 'test crash' })) })
  return api
}
