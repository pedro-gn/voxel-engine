import { AIR, createEngine, openSave, packVoxel, type LoadedSave } from '@elovox/engine'
import { BLOCKS, DECORATIONS } from './blocks.ts'
import { spawnCharacter } from './character.ts'
import { createWorkersView } from './workersView.ts'
import { WORKERS_SIZE, WORKER_OPTIONS } from './scenes/workers.ts'
import { LIVING_SIZE, LIVING_WORKER_OPTIONS } from './scenes/living.ts'
import { createLiving, createLivingBar } from './livingScript.ts'
import livingDoc from './terrain/living.terrain.json'
import { CROWD_SIZE, CROWD_WORKER_OPTIONS } from './scenes/crowd.ts'
import { createCrowd, createCrowdBar, crowdCamera } from './crowdScript.ts'
import crowdDoc from './terrain/crowd.terrain.json'
import { createControls } from './controls.ts'
import { createTerrainEditor } from '@elovox/terrain-editor'
import { createHud } from './hud.ts'
import { CAVES_SIZE, digTunnelCommands, openCanalCommands, openDamCommands, pierceRoofCommands } from './scenes/caves.ts'
import { DIORAMA_SIZE } from './scenes/diorama.ts'
import { FLOOD_SIZE, breachCommands, digCommands, dropCommands, stopSpringCommands, stressCommands } from './scenes/flood.ts'
import { paintTextures } from './textures.ts'
import e2eDoc from './terrain/e2e.terrain.json'
import showcaseDoc from './terrain/showcase.terrain.json'
import { randomTickRate } from './rules.ts'
import { COLLAPSE_SIZE, cutLeftCommands, cutRightCommands, cutTowerCommands, cutNormalCommands, stressCollapseCommands } from './scenes/collapse.ts'
import { createTerrainPanel } from './terrainPanel.ts'
import { createFirstPerson } from './firstPerson.ts'
import { applyCamera, captureCamera, isAppState, type AppState } from './appState.ts'
import { bootPlan } from './scene.ts'

const HOTBAR = ['stone', 'dirt', 'grass', 'sand', 'planks', 'log', 'leaves', 'water', 'torch', 'glass']
const params = new URLSearchParams(location.search)
const persistWorker = () => new Worker(new URL('./persist.worker.ts', import.meta.url), { type: 'module' })
/** Shows why a save could not be loaded, with a way back to the scene; the page stops there. */
function showLoadError(slot: string, e: unknown): never {
  const box = document.createElement('div')
  Object.assign(box.style, { position: 'fixed', inset: '0', display: 'grid', placeItems: 'center', background: '#f6f8f1', color: '#233027', font: '14px/1.5 system-ui, sans-serif', zIndex: '20' })
  const inner = document.createElement('div'); inner.style.maxWidth = '560px'
  const h = document.createElement('h2'); h.textContent = `The save "${slot}" could not be loaded`
  const p = document.createElement('pre'); p.style.whiteSpace = 'pre-wrap'; p.textContent = e instanceof Error ? e.message : String(e)
  const back = new URLSearchParams(location.search); back.delete('save')
  const a = document.createElement('a'); a.href = `?${back}`; a.textContent = 'Start the scene fresh'
  inner.append(h, p, a); box.append(inner); document.body.append(box)
  throw e
}
const saveParam = params.get('save')
const saved: (LoadedSave & { app: unknown }) | null = saveParam ? await openSave(saveParam, persistWorker).catch((e: unknown) => showLoadError(saveParam, e)) : null
const savedApp: AppState | null = saved && isAppState(saved.app) ? saved.app : null
const { scene: sceneName, fromSave } = bootPlan(params, saved)
if (sceneName === 'collapse') HOTBAR.splice(4, 2, 'structural_planks', 'structural_glass')
/** `?size=` rounded to a multiple of 32 in [32, 1024]; anything unparseable falls back to 1024. */
function worldSide(raw: string | null): number {
  const v = Number(raw ?? 1024)
  if (!Number.isFinite(v)) return 1024
  return Math.min(1024, Math.max(32, Math.round(v / 32) * 32))
}
/** `?scene=terrain&edit` opens the terrain editor on the scene's document (not on a loaded save: it edits the scene file). */
const editing = sceneName === 'terrain' && params.has('edit') && !fromSave
const EDIT_HINT = '1–4 mode · Ops: LMB select, drag handles/outline, Shift-drag height, Alt-click remove vertex, Del, Ctrl+D, H · ' +
  'Brushes: LMB paint, Ctrl invert, Shift keep depth, [ ] radius · Ctrl+Z/Y · RMB rotate'
const n = worldSide(params.get('size'))
const seed = Number(params.get('seed') ?? 1234)
/** The terrain scene loads the 1024² showcase, or the small e2e document when `?size=` is 256 or less. */
const terrainDoc = sceneName === 'terrain' ? (n <= 256 ? e2eDoc : showcaseDoc) : undefined
const size: [number, number, number] = saved ? [...saved.manifest.size] : sceneName === 'flood' ? [...FLOOD_SIZE]
  : sceneName === 'workers' ? [...WORKERS_SIZE]
  : sceneName === 'living' ? [...LIVING_SIZE]
  : sceneName === 'crowd' ? [...CROWD_SIZE]
  : sceneName === 'collapse' ? [...COLLAPSE_SIZE]
  : sceneName === 'caves' ? [...CAVES_SIZE]
  : sceneName === 'diorama' ? [...DIORAMA_SIZE]
  : terrainDoc ? [terrainDoc.size[0]!, 128, terrainDoc.size[1]!]
  : [n, 128, n]
const canvas = document.querySelector<HTMLCanvasElement>('#view')!

const engine = await createEngine({
  canvas,
  size,
  seed,
  blocks: BLOCKS,
  decorations: DECORATIONS,
  textures: paintTextures(),
  simWorker: sceneName === 'diorama'
    ? () => new Worker(new URL('./diorama.worker.ts', import.meta.url), { type: 'module' })
    : sceneName === 'workers' ? () => new Worker(new URL('./workers.worker.ts', import.meta.url), { type: 'module' })
    : sceneName === 'collapse'
      ? () => new Worker(new URL('./collapse.worker.ts', import.meta.url), { type: 'module' })
    : sceneName === 'flood'
      ? () => new Worker(new URL('./flood.worker.ts', import.meta.url), { type: 'module' })
    : sceneName === 'caves'
      ? () => new Worker(new URL('./caves.worker.ts', import.meta.url), { type: 'module' })
    : sceneName === 'terrain' || sceneName === 'living' || sceneName === 'crowd'
      ? () => new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' })
      : () => new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' }),
  terrain: sceneName === 'flood' ? { scene: 'flood' } : sceneName === 'caves' ? { scene: 'caves' }
    : sceneName === 'collapse' ? { scene: 'collapse', stress: params.has('stress') } : sceneName === 'living' ? livingDoc : sceneName === 'crowd' ? crowdDoc : terrainDoc,
  genWorker: terrainDoc || sceneName === 'living' || sceneName === 'crowd' ? () => new Worker(new URL('./gen.worker.ts', import.meta.url), { type: 'module' }) : undefined,
  // ?still: the world stays exactly as generated (no physics, no random ticks), for the regenerate e2e.
  sim: params.has('still')
    ? { randomTicksPerChunk: 0, debugFluids: params.has('debugFluids'), paused: true, ...(sceneName === 'workers' ? { workers: WORKER_OPTIONS } : sceneName === 'living' ? { workers: LIVING_WORKER_OPTIONS } : sceneName === 'crowd' ? { workers: CROWD_WORKER_OPTIONS } : {}) }
    : { randomTicksPerChunk: randomTickRate(size[0], size[2]), debugFluids: params.has('debugFluids'), ...(sceneName === 'workers' ? { workers: WORKER_OPTIONS } : sceneName === 'living' ? { workers: LIVING_WORKER_OPTIONS } : sceneName === 'crowd' ? { workers: CROWD_WORKER_OPTIONS } : {}) },
  forceWebGL: params.has('webgl'),
  gpuTiming: params.has('gpu'),
  // ?nobatch: one mesh per chunk layer instead of region batches (the before/after of perf candidate #3).
  batchChunks: !params.has('nobatch'),
  // ?nowaterworker: the water host runs on the main thread (the before of 4a-r2 #2's A/B).
  waterWorker: !params.has('nowaterworker'),
  // ?cull=three: three's own batch cull, the reference picture of the engine's cull (e2e/batching.spec.ts).
  threeCull: params.get('cull') === 'three',
  // ?region=8: chunk columns per region batch (the 4b region-size A/B; internal).
  ...(params.has('region') && { regionChunks: Number(params.get('region')) }),
  // Every layer of the texture array shares this size; the hand-painted tiles are 512 px, so they
  // render at full resolution (~14 layers ≈ 19 MB with mipmaps).
  tileSize: 512,
  persistWorker,
  ...(saved && { restore: saved }),
})
void navigator.storage?.persist?.().catch(() => false) // ask once that the browser keep the saves under storage pressure

engine.atmosphere.set(sceneName === 'diorama' ? 'diorama' : 'open')
// A loaded save brings its own camera (applied once the scene objects exist): skip the scene's preset views.
const presetCamera = !fromSave
// ?view=<blocks>: the view distance (Quality.viewDistance), for the 4b checkpoints.
if (params.has('view')) engine.quality = { viewDistance: Number(params.get('view')) }
if (sceneName === 'diorama') {
  engine.quality = { decorationRadius: 256 } // the 128-block diorama is viewed from ~150 blocks; the engine default (96) would fade all grass out
  if (presetCamera) for (const s of [engine.controls.goal, engine.controls.current]) {
    s.target[0] = 64; s.target[1] = 30; s.target[2] = 64
    s.distance = 150
    s.pitch = 0.7
    s.yaw = 0.7 + Math.PI // camera on the lower-terrace side, so the cliff faces the viewer
  }
}
if (sceneName === 'terrain') {
  if (presetCamera) for (const s of [engine.controls.goal, engine.controls.current]) {
    s.target[0] = size[0] / 2; s.target[1] = 50; s.target[2] = size[2] / 2
    s.distance = Math.min(400, size[0] * 0.6)
    s.pitch = 0.75
  }
  if (!editing) createTerrainPanel(engine, terrainDoc!)
}
if (sceneName === 'flood' && presetCamera) {
  for (const s of [engine.controls.goal, engine.controls.current]) {
    s.target[0] = 128; s.target[1] = 20; s.target[2] = 128
    s.distance = 320
    s.pitch = 0.8
  }
}
if (sceneName === 'caves' && presetCamera) {
  for (const s of [engine.controls.goal, engine.controls.current]) {
    s.target[0] = 64; s.target[1] = 26; s.target[2] = 64
    s.distance = 200
    s.pitch = 0.8
  }
}
if (sceneName === 'collapse' && presetCamera) {
  for (const s of [engine.controls.goal, engine.controls.current]) {
    s.target[0] = 56; s.target[1] = 12; s.target[2] = 46; s.distance = 140; s.pitch = 0.75; s.yaw = 0.7
  }
}
const unitsScene = sceneName === 'workers' || sceneName === 'living' || sceneName === 'crowd'
createControls(engine, { collapsed: editing || unitsScene })
if (unitsScene) Object.assign(document.getElementById('controls')!.style, { top: 'auto', right: 'auto', bottom: '12px', left: '12px' })
const editor = editing
  ? createTerrainEditor(engine, { doc: terrainDoc, seed, fileName: n <= 256 ? 'e2e.terrain.json' : 'showcase.terrain.json' })
  : null

// The bean stands at the camera target, facing the camera; V toggles idle / walk.
engine.controls.apply(engine.camera)
const [bx, , bz] = engine.controls.current.target
if (sceneName === 'crowd' && presetCamera) crowdCamera(engine)
if (sceneName === 'workers' && presetCamera) {
  for (const s of [engine.controls.goal, engine.controls.current]) { s.target[0] = 44; s.target[1] = 7; s.target[2] = 34; s.distance = 125; s.pitch = .8; s.yaw = .7 }
  engine.controls.apply(engine.camera)
}
const bean = unitsScene ? null : await spawnCharacter(engine, `${import.meta.env.BASE_URL}models/bean.glb`, Math.floor(bx) + 0.5, Math.floor(bz) + 0.5)
const workers = unitsScene ? await createWorkersView(engine, canvas, { demo: sceneName === 'workers' }) : null

let selected = 0
const hotbarVoxel = () => { const id = engine.blocks.id(HOTBAR[selected]!); return engine.blocks.liquid[id] ? packVoxel(id, 7) : id }
createHud(engine, () => HOTBAR[selected]!, editing ? 'terrain · edit' : sceneName, editing ? { corner: 'bottom', hint: EDIT_HINT } : {})
window.addEventListener('keydown', (e) => {
  if (unitsScene) return
  if (e.key === 'v' || e.key === 'V') bean?.play(bean.clip === 'walk' ? 'idle' : 'walk')
  const k = e.key === '0' ? 10 : Number(e.key)
  if (k >= 1 && k <= HOTBAR.length) selected = k - 1
})
// C: first person (not in the terrain editor); dig/place from the crosshair only where orbit digs/places.
const fp = editing ? null : createFirstPerson(engine, canvas, { edits: !unitsScene, voxel: hotbarVoxel })

canvas.addEventListener('pointermove', (e) => {
  if (editing || workers) return
  engine.setHighlight(engine.pickScreen(e.clientX, e.clientY)?.pos ?? null)
})
canvas.addEventListener('pointerup', (e) => {
  if (editing || workers) return
  const hit = engine.pickScreen(e.clientX, e.clientY)
  if (!hit) return
  if (e.button === 0) {
    engine.submit({ type: 'setBlock', pos: hit.pos, voxel: AIR })
  } else if (e.button === 2 && engine.controls.lastDragDistance < 6) {
    const [nx, ny, nz] = hit.normal
    if (nx === 0 && ny === 0 && nz === 0) return
    const p = [hit.pos[0] + nx, hit.pos[1] + ny, hit.pos[2] + nz] as const
    if (!engine.layout.inBounds(p[0], p[1], p[2])) return
    engine.submit({ type: 'setBlock', pos: p, voxel: hotbarVoxel() })
  }
  engine.setHighlight(engine.pickScreen(e.clientX, e.clientY)?.pos ?? null)
})

const flood = sceneName === 'flood'
  ? {
      breach: () => breachCommands().forEach((c) => engine.submit(c)),
      drop: () => dropCommands().forEach((c) => engine.submit(c)),
      stopSpring: () => stopSpringCommands(engine.blocks.id('stone')).forEach((c) => engine.submit(c)),
      dig: () => digCommands().forEach((c) => engine.submit(c)),
      stress: () => stressCommands(packVoxel(engine.blocks.id('water'), 7)).forEach((c) => engine.submit(c)),
    }
  : null
const caves = sceneName === 'caves'
  ? {
      digTunnel: () => digTunnelCommands().forEach((c) => engine.submit(c)),
      pierceRoof: () => pierceRoofCommands().forEach((c) => engine.submit(c)),
      openDam: () => openDamCommands().forEach((c) => engine.submit(c)),
      openCanal: () => openCanalCommands().forEach((c) => engine.submit(c)),
    }
  : null
const collapse = sceneName === 'collapse' ? {
  cutLeft: () => cutLeftCommands().forEach(c => engine.submit(c)),
  cutRight: () => cutRightCommands().forEach(c => engine.submit(c)),
  cutTower: () => cutTowerCommands().forEach(c => engine.submit(c)),
  cutNormal: () => cutNormalCommands().forEach(c => engine.submit(c)),
  stress: () => stressCollapseCommands().forEach(c => engine.submit(c)),
} : null
if (collapse) {
  const bar = document.createElement('div'); bar.setAttribute('aria-label', 'Structural collapse demonstrations')
  Object.assign(bar.style, { position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: '8px', zIndex: '10' })
  for (const [label, action] of [['Cut left support', collapse.cutLeft], ['Cut right support', collapse.cutRight], ['Collapse tower', collapse.cutTower], ['Cut normal beam', collapse.cutNormal]] as const) {
    const button = document.createElement('button'); button.textContent = label
    Object.assign(button.style, { padding: '10px 14px', border: '1px solid #bcc7b9', borderRadius: '6px', background: '#f6f8f1', color: '#233027', cursor: 'pointer' })
    button.addEventListener('click', () => { action(); button.disabled = true }); bar.append(button)
  }
  document.body.append(bar)
}
const living = sceneName === 'living' ? createLiving(engine) : null
if (living && fromSave) living.restore(savedApp?.scripts.living ?? { started: false, breached: false, collapsed: false, groupAtRest: false })
else if (living) { living.camera('default'); await living.setup() }
if (living) createLivingBar(living)
// ?units=N: the crowd's size (the e2e uses 50).
const crowd = sceneName === 'crowd' ? createCrowd(engine, Number(params.get('units') ?? 1000)) : null
if (crowd && savedApp?.scripts.crowd) crowd.restore(savedApp.scripts.crowd)
if (crowd) createCrowdBar(crowd)
if (savedApp) applyCamera(engine, savedApp.camera, () => fp ? fp.toggle() : engine.setCameraMode('firstPerson'))

/** The sandbox's part of a save: which scene, where the camera is, and how far the scene scripts got. */
const captureApp = (): AppState => ({
  scene: sceneName, camera: captureCamera(engine),
  scripts: { ...(living && { living: living.save() }), ...(crowd && { crowd: crowd.save() }) },
})
const save = (slot: string) => engine.save(slot, { app: captureApp(), meta: { scene: sceneName } })
Object.assign(window, { __elovox: { engine, bean, editor, flood, caves, collapse, workers, living, crowd, fp, save, ready: true } })
