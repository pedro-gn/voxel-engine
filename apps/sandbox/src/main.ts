import { AIR, createEngine } from '@elovox/engine'
import { BLOCKS, DECORATIONS } from './blocks.ts'
import { createControls } from './controls.ts'
import { createHud } from './hud.ts'
import { DIORAMA_SIZE } from './scenes/diorama.ts'
import { paintTextures } from './textures.ts'

const HOTBAR = ['stone', 'dirt', 'grass', 'sand', 'planks', 'log', 'leaves', 'rock', 'torch', 'glass']
const params = new URLSearchParams(location.search)
const sceneName = params.get('scene') === 'diorama' ? 'diorama' : 'world'
/** `?size=` rounded to a multiple of 32 in [32, 1024]; anything unparseable falls back to 1024. */
function worldSide(raw: string | null): number {
  const v = Number(raw ?? 1024)
  if (!Number.isFinite(v)) return 1024
  return Math.min(1024, Math.max(32, Math.round(v / 32) * 32))
}
const n = worldSide(params.get('size'))
const canvas = document.querySelector<HTMLCanvasElement>('#view')!

const engine = await createEngine({
  canvas,
  size: sceneName === 'diorama' ? [...DIORAMA_SIZE] : [n, 128, n],
  seed: Number(params.get('seed') ?? 1234),
  blocks: BLOCKS,
  decorations: DECORATIONS,
  textures: paintTextures(),
  simWorker: sceneName === 'diorama'
    ? () => new Worker(new URL('./diorama.worker.ts', import.meta.url), { type: 'module' })
    : () => new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' }),
  forceWebGL: params.has('webgl'),
  gpuTiming: params.has('gpu'),
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
createControls(engine)

let selected = 0
createHud(engine, () => HOTBAR[selected]!, sceneName)
window.addEventListener('keydown', (e) => {
  const k = e.key === '0' ? 10 : Number(e.key)
  if (k >= 1 && k <= HOTBAR.length) selected = k - 1
})

canvas.addEventListener('pointermove', (e) => {
  engine.setHighlight(engine.pickScreen(e.clientX, e.clientY)?.pos ?? null)
})
canvas.addEventListener('pointerup', (e) => {
  const hit = engine.pickScreen(e.clientX, e.clientY)
  if (!hit) return
  if (e.button === 0) {
    engine.submit({ type: 'setBlock', pos: hit.pos, voxel: AIR })
  } else if (e.button === 2 && engine.controls.lastDragDistance < 6) {
    const [nx, ny, nz] = hit.normal
    if (nx === 0 && ny === 0 && nz === 0) return
    const p = [hit.pos[0] + nx, hit.pos[1] + ny, hit.pos[2] + nz] as const
    if (!engine.layout.inBounds(p[0], p[1], p[2])) return
    engine.submit({ type: 'setBlock', pos: p, voxel: engine.blocks.id(HOTBAR[selected]!) })
  }
  engine.setHighlight(engine.pickScreen(e.clientX, e.clientY)?.pos ?? null)
})

Object.assign(window, { __elovox: { engine, ready: true } })
