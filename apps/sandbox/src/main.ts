import { createEngine } from '@elovox/engine'
import { BLOCKS } from './blocks.ts'

const params = new URLSearchParams(location.search)
const n = Number(params.get('size') ?? 1024)
const engine = await createEngine({
  canvas: document.querySelector<HTMLCanvasElement>('#view')!,
  size: [n, 128, n],
  seed: Number(params.get('seed') ?? 1234),
  blocks: BLOCKS,
  textures: {},
  simWorker: () => new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' }),
  forceWebGL: params.has('webgl'),
})
Object.assign(window, { __elovox: { engine, ready: true } })
