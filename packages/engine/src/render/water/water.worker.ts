import type { WorldBuffers } from '../../world/buffers.ts'
import { WorldReader } from '../../world/reader.ts'
import type { DrawnSurfaces } from './surfaceView.ts'
import { WaterHost, type WaterRequest } from './waterHost.ts'

/** Main thread → water worker. `opaque`: the registry's opaque table, for the light reader. */
export type ToWater =
  | { type: 'init'; buffers: WorldBuffers; opaque: Uint8Array; pages: SharedArrayBuffer[]; stepHz: number; surfaces: DrawnSurfaces }
  | { type: 'page'; index: number; page: SharedArrayBuffer }
  | WaterRequest

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<ToWater>) => void) | null
}
const scope = globalThis as unknown as WorkerScope
let reader: WorldReader | null = null
let host: WaterHost | null = null

scope.onmessage = (e) => {
  const m = e.data
  if (m.type === 'init') {
    const r = new WorldReader(m.buffers, m.opaque)
    m.pages.forEach((p, i) => r.addPage(i, p))
    reader = r
    // In the worker every publish arrives a main-thread turn late: a stale one catches up (SurfaceView.apply).
    host = new WaterHost(m.buffers.size, m.buffers.water, (x, y, z) => r.getLight(x, y, z), m.stepHz, m.surfaces, true)
    return
  }
  if (m.type === 'page') { reader?.addPage(m.index, m.page); return }
  // An exception here reaches the main thread as the worker's error event: the engine respawns once (spec 4.5).
  const reply = host!.handle(m)
  scope.postMessage(reply, [reply.keys.buffer, reply.data.buffer])
}
