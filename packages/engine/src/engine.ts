import * as THREE from 'three/webgpu'
import { BlockRegistry, type BlockDef } from './blocks/registry.ts'
import { columnTop, ghostAwareGet, markTick } from './engineWorld.ts'
import { EngineError, showErrorScreen } from './errors.ts'
import { GhostEdits } from './interact/ghostEdits.ts'
import { OrbitCamera } from './interact/orbitCamera.ts'
import { raycast, type RayHit, type Vec3Like } from './interact/raycast.ts'
import { DecorationRegistry, type DecorationDef } from './render/decorations/defs.ts'
import { meshTablesFrom } from './mesh/tables.ts'
import type { FromMesh, FromSim, SimInitOptions, ToMesh, ToSim } from './protocol.ts'
import type { AtmosphereController } from './render/atmosphere.ts'
import type { Effects, Quality, WaterInput, WaterParams } from './render/settings.ts'
import { Visuals } from './render/visuals.ts'
import { MeshQueue, PRIORITY } from './render/meshQueue.ts'
import { buildTextureArray } from './render/textureArray.ts'
import { validateCommand, type Ack, type Command, type SetBlockCommand } from './sim/commands.ts'
import type { SimEvent } from './sim/simulation.ts'
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
}

export interface EngineEvents {
  ready: { chunks: number }
  tick: { tick: number; tickMs: number }
  event: SimEvent
  ack: Ack
  log: { message: string }
  /** `slots` is set when the world ran out of slot pages. */
  fatal: { message: string; slots?: number }
}

export interface EngineStats {
  fps: number; frameMs: number; tick: number; tickMs: number
  meshQueue: number; meshInFlight: number; failedChunks: number
  slotsUsed: number; meshes: number; drawCalls: number; backend: 'webgpu' | 'webgl'
  shadowCasters: number
  decorationInstances: number; decorationDraws: number
}

export interface Engine {
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

interface PoolSlot { worker: Worker; job: { id: number; chunk: number } | null; crashes: number }
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
  const buffers = createWorldBuffers(size)
  const reader = new WorldReader(buffers, registry.opaque)
  const ghosts = new GhostEdits(layout)
  const queue = new MeshQueue()
  const events = new Emitter<EngineEvents>()
  const pages: SharedArrayBuffer[] = []

  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL: o.forceWebGL ?? false })
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

  const tex = await buildTextureArray(o.textures, registry.textureNames())
  tex.texture.anisotropy = renderer.getMaxAnisotropy()
  const tables = meshTablesFrom(registry, registry.faceLayers(tex.layerOf), decorations.tables)
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
    renderer, scene, camera, backend, texture: tex.texture, layout,
    viewDistance: () => controls.current.distance,
    decorations,
  })

  // ---- lifecycle ----
  // No await between here and `await ready`, so an early rejection always has a handler.
  let resolveReady!: (chunks: number) => void
  let rejectReady!: (err: EngineError) => void
  const ready = new Promise<number>((res, rej) => { resolveReady = res; rejectReady = rej })
  const sim = o.simWorker()
  const pool: PoolSlot[] = []
  let halted = false
  let fatal: string | null = null
  /** Stops ticking, meshing and rendering. GPU resources stay until dispose(). */
  const halt = () => {
    if (halted) return
    halted = true
    renderer.setAnimationLoop(null)
    sim.terminate()
    for (const s of pool) s.worker.terminate()
  }
  const fail = (message: string, slots?: number) => {
    if (fatal !== null) return
    fatal = message
    halt()
    console.error(`[elovox] fatal: ${message}`)
    events.emit('fatal', slots === undefined ? { message } : { message, slots })
    showErrorScreen(canvas, 'The engine stopped', message)
    rejectReady(new EngineError('fatal', message))
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
    slot.job = null
    slot.crashes = 0 // the worker is alive and answering
    if (m.type === 'result') {
      queue.finish(m.chunk)
      failures.delete(m.chunk)
      failed.delete(m.chunk)
      results.push(m)
    } else if (m.type === 'retry') {
      queue.retry(m.chunk)
    } else {
      jobFailed(m.chunk, m.message)
    }
  }
  const spawn = (i: number, crashes: number) => {
    if (halted) return
    const worker = new Worker(new URL('./mesh/mesh.worker.ts', import.meta.url), { type: 'module' })
    const slot: PoolSlot = { worker, job: null, crashes }
    worker.onmessage = (e: MessageEvent<FromMesh>) => onMeshMessage(slot, e.data)
    worker.onerror = (e) => {
      e.preventDefault()
      worker.terminate()
      const reason = e.message || 'the worker failed to load or crashed'
      const job = slot.job
      slot.job = null
      if (job) jobFailed(job.chunk, `mesh worker crashed: ${reason}`)
      if (slot.crashes + 1 >= MAX_WORKER_CRASHES) fail(`mesh worker keeps crashing: ${reason}`)
      else spawn(i, slot.crashes + 1)
    }
    worker.postMessage({ type: 'init', buffers, pages: [...pages], tables } satisfies ToMesh)
    pool[i] = slot
  }
  const poolSize = o.meshWorkers ?? Math.max(1, Math.min(6, (navigator.hardwareConcurrency || 4) - 2))
  for (let i = 0; i < poolSize; i++) spawn(i, 0)

  // ---- sim worker ----
  let lastTick = 0, lastTickMs = 0, slotsUsed = 0
  sim.onmessage = (e: MessageEvent<FromSim>) => {
    const m = e.data
    switch (m.type) {
      case 'page':
        pages[m.index] = m.page
        reader.addPage(m.index, m.page)
        for (const s of pool) s.worker.postMessage({ type: 'page', index: m.index, page: m.page } satisfies ToMesh)
        break
      case 'ready':
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
        for (const a of m.acks) events.emit('ack', a)
        for (const ev of m.events) events.emit('event', ev)
        events.emit('tick', { tick: m.tick, tickMs: m.tickMs })
        break
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
  sim.postMessage({ type: 'init', buffers, blocks: o.blocks, seed: o.seed, options: o.sim ?? {} } satisfies ToSim)

  // ---- frame loop ----
  const distanceTo = (ci: number) => {
    const [cx, cy, cz] = layout.chunkCoords(ci)
    const dx = cx * 32 + 16 - camera.position.x, dy = cy * 32 + 16 - camera.position.y, dz = cz * 32 + 16 - camera.position.z
    return dx * dx + dy * dy + dz * dz
  }
  const dispatch = () => {
    for (const slot of pool) {
      if (slot.job) continue
      const ci = queue.next(distanceTo)
      if (ci < 0) return
      const overrides = ghosts.size > 0 ? ghosts.overridesFor(ci) : []
      const msg: ToMesh = overrides.length > 0
        ? { type: 'job', id: ++jobId, chunk: ci, overrides }
        : { type: 'job', id: ++jobId, chunk: ci }
      slot.job = { id: msg.id, chunk: ci }
      slot.worker.postMessage(msg)
    }
  }
  const upload = () => {
    // The budget measures Visuals.applyMesh CPU time only; the GPU upload happens later, inside renderer.render.
    const start = performance.now()
    while (results.length > 0 && performance.now() - start < UPLOAD_BUDGET_MS) {
      const r = results.shift()!
      if (queue.accept(r.chunk, r.version)) visuals.applyMesh(r.chunk, r.data)
    }
  }
  let last = performance.now(), fpsT = last, frames = 0, fps = 0, frameMs = 0
  renderer.setAnimationLoop(() => {
    const now = performance.now()
    const dt = Math.min(0.1, (now - last) / 1000)
    last = now
    controls.update(dt)
    controls.apply(camera)
    dispatch()
    upload()
    visuals.frame(dt)
    frameMs = performance.now() - now
    frames++
    if (now - fpsT >= 500) { fps = (frames * 1000) / (now - fpsT); frames = 0; fpsT = now }
  })

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    halt()
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

  return {
    scene, camera, renderer, blocks: registry, layout, controls, world,
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
        for (const ci of ghosts.add(s, c.pos[0], c.pos[1], c.pos[2], c.voxel)) markDirty(ci, PRIORITY.GHOST)
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
    stats: () => ({
      fps, frameMs, tick: lastTick, tickMs: lastTickMs,
      meshQueue: queue.size, meshInFlight: queue.inFlightCount, failedChunks: failed.size,
      slotsUsed, meshes: visuals.chunks.meshCount, drawCalls: renderer.info.render.drawCalls, backend,
      ...(({ shadowCasters, decorationInstances, decorationDraws }) => ({ shadowCasters, decorationInstances, decorationDraws }))(visuals.stats()),
    }),
    dispose,
  }
}
