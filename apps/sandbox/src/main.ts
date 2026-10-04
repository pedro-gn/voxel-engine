import { AIR, createEngine, packVoxel } from '@elovox/engine'
import { BLOCKS, DECORATIONS } from './blocks.ts'
import { spawnCharacter } from './character.ts'
import { createControls } from './controls.ts'
import { createTerrainEditor } from '@elovox/terrain-editor'
import { createHud } from './hud.ts'
import { DIORAMA_SIZE } from './scenes/diorama.ts'
import { FLOOD_SIZE, breachCommands, dropCommands } from './scenes/flood.ts'
import { paintTextures } from './textures.ts'
import e2eDoc from './terrain/e2e.terrain.json'
import showcaseDoc from './terrain/showcase.terrain.json'
import { randomTickRate } from './rules.ts'
import { createTerrainPanel } from './terrainPanel.ts'

const HOTBAR = ['stone', 'dirt', 'grass', 'sand', 'planks', 'log', 'leaves', 'water', 'torch', 'glass']
const params = new URLSearchParams(location.search)
const sceneParam = params.get('scene')
const sceneName = sceneParam === 'diorama' || sceneParam === 'terrain' || sceneParam === 'flood' ? sceneParam : 'world'
/** `?size=` rounded to a multiple of 32 in [32, 1024]; anything unparseable falls back to 1024. */
function worldSide(raw: string | null): number {
  const v = Number(raw ?? 1024)
  if (!Number.isFinite(v)) return 1024
  return Math.min(1024, Math.max(32, Math.round(v / 32) * 32))
}
/** `?scene=terrain&edit` opens the terrain editor on the scene's document. */
const editing = sceneName === 'terrain' && params.has('edit')
const EDIT_HINT = '1–4 mode · Ops: LMB select, drag handles/outline, Shift-drag height, Alt-click remove vertex, Del, Ctrl+D, H · ' +
  'Brushes: LMB paint, Ctrl invert, Shift keep depth, [ ] radius · Ctrl+Z/Y · RMB rotate'
const n = worldSide(params.get('size'))
const seed = Number(params.get('seed') ?? 1234)
/** The terrain scene loads the 1024² showcase, or the small e2e document when `?size=` is 256 or less. */
const terrainDoc = sceneName === 'terrain' ? (n <= 256 ? e2eDoc : showcaseDoc) : undefined
const size: [number, number, number] = sceneName === 'flood' ? [...FLOOD_SIZE]
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
    : sceneName === 'flood'
      ? () => new Worker(new URL('./flood.worker.ts', import.meta.url), { type: 'module' })
    : sceneName === 'terrain'
      ? () => new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' })
      : () => new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' }),
  terrain: sceneName === 'flood' ? { scene: 'flood' } : terrainDoc,
  genWorker: terrainDoc ? () => new Worker(new URL('./gen.worker.ts', import.meta.url), { type: 'module' }) : undefined,
  // ?still: the world stays exactly as generated (no physics, no random ticks), for the regenerate e2e.
  sim: params.has('still')
    ? { randomTicksPerChunk: 0, debugFluids: params.has('debugFluids'), paused: true }
    : { randomTicksPerChunk: randomTickRate(size[0], size[2]), debugFluids: params.has('debugFluids') },
  forceWebGL: params.has('webgl'),
  gpuTiming: params.has('gpu'),
  // Every layer of the texture array shares this size; the hand-painted tiles are 512 px, so they
  // render at full resolution (~14 layers ≈ 19 MB with mipmaps).
  tileSize: 512,
})

engine.atmosphere.set(sceneName === 'diorama' ? 'diorama' : 'open')
if (sceneName === 'diorama') {
  engine.quality = { decorationRadius: 256 } // the 128-block diorama is viewed from ~150 blocks; the engine default (96) would fade all grass out
  for (const s of [engine.controls.goal, engine.controls.current]) {
    s.target[0] = 64; s.target[1] = 30; s.target[2] = 64
    s.distance = 150
    s.pitch = 0.7
    s.yaw = 0.7 + Math.PI // camera on the lower-terrace side, so the cliff faces the viewer
  }
}
if (sceneName === 'terrain') {
  for (const s of [engine.controls.goal, engine.controls.current]) {
    s.target[0] = size[0] / 2; s.target[1] = 50; s.target[2] = size[2] / 2
    s.distance = Math.min(400, size[0] * 0.6)
    s.pitch = 0.75
  }
  if (!editing) createTerrainPanel(engine, terrainDoc!)
}
if (sceneName === 'flood') {
  for (const s of [engine.controls.goal, engine.controls.current]) {
    s.target[0] = 128; s.target[1] = 20; s.target[2] = 128
    s.distance = 320
    s.pitch = 0.8
  }
}
createControls(engine, { collapsed: editing })
const editor = editing
  ? createTerrainEditor(engine, { doc: terrainDoc, seed, fileName: n <= 256 ? 'e2e.terrain.json' : 'showcase.terrain.json' })
  : null

// The bean stands at the camera target, facing the camera; V toggles idle / walk.
engine.controls.apply(engine.camera)
const [bx, , bz] = engine.controls.current.target
const bean = await spawnCharacter(engine, `${import.meta.env.BASE_URL}models/bean.glb`, Math.floor(bx) + 0.5, Math.floor(bz) + 0.5)

let selected = 0
createHud(engine, () => HOTBAR[selected]!, editing ? 'terrain · edit' : sceneName, editing ? { corner: 'bottom', hint: EDIT_HINT } : {})
window.addEventListener('keydown', (e) => {
  if (e.key === 'v' || e.key === 'V') bean.play(bean.clip === 'walk' ? 'idle' : 'walk')
  const k = e.key === '0' ? 10 : Number(e.key)
  if (k >= 1 && k <= HOTBAR.length) selected = k - 1
})

canvas.addEventListener('pointermove', (e) => {
  if (editing) return
  engine.setHighlight(engine.pickScreen(e.clientX, e.clientY)?.pos ?? null)
})
canvas.addEventListener('pointerup', (e) => {
  if (editing) return
  const hit = engine.pickScreen(e.clientX, e.clientY)
  if (!hit) return
  if (e.button === 0) {
    engine.submit({ type: 'setBlock', pos: hit.pos, voxel: AIR })
  } else if (e.button === 2 && engine.controls.lastDragDistance < 6) {
    const [nx, ny, nz] = hit.normal
    if (nx === 0 && ny === 0 && nz === 0) return
    const p = [hit.pos[0] + nx, hit.pos[1] + ny, hit.pos[2] + nz] as const
    if (!engine.layout.inBounds(p[0], p[1], p[2])) return
    const id = engine.blocks.id(HOTBAR[selected]!)
    engine.submit({ type: 'setBlock', pos: p, voxel: engine.blocks.liquid[id] ? packVoxel(id, 7) : id })
  }
  engine.setHighlight(engine.pickScreen(e.clientX, e.clientY)?.pos ?? null)
})

const flood = sceneName === 'flood'
  ? { breach: () => breachCommands().forEach((c) => engine.submit(c)), drop: () => dropCommands().forEach((c) => engine.submit(c)) }
  : null
Object.assign(window, { __elovox: { engine, bean, editor, flood, ready: true } })
