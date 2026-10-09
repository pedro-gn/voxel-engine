import type { WaterTick } from '../../sim/water/publish.ts'
import type { WorldSize } from '../../world/layout.ts'
import type { WaterBuffers } from '../../world/waterBuffers.ts'
import { SurfaceView, type DrawnSurfaces } from './surfaceView.ts'

/** Main thread → water host: one tick's publish (null: none) and the light ranges [cc, y0, y1]* to re-read after it. */
export interface WaterRequest { type: 'apply'; id: number; tick: number; water: WaterTick | null; shown: number; relight: number[] }
/** Water host → main thread: whether the publish was applied, the host's cost (ms), and the data of every key that changed (packDirty). */
export interface WaterReply { type: 'result'; id: number; tick: number; applied: boolean; hostMs: number; keys: Int32Array; data: Float32Array }

/** Floats per row of a ColumnData array: 32 instances × 4. */
const ROW = 128
/** Ints per key in WaterReply.keys. */
export const KEY_INTS = 4

/**
 * Takes the view's dirty keys and packs what the renderer reads: per key [key, rowLo, rowHi, curtain count] (count −1: the
 * key has no data), then in `data`, key by key, rows rowLo..rowHi of hPrev, hCur and info (none when rowLo > rowHi), then
 * the first count × 4 floats of the six curtain arrays (prev, cur, reach, thick, flare, info). Resets each key's row range,
 * as WaterSurface.sync does when it uploads.
 */
export function packDirty(view: SurfaceView): { keys: Int32Array; data: Float32Array } {
  const dirty = view.takeDirty(), n = view.ccCount
  let floats = 0
  for (const key of dirty) {
    const cc = key % n, d = view.column(cc, (key - cc) / n)
    if (!d) continue
    if (d.rowLo <= d.rowHi) floats += (d.rowHi - d.rowLo + 1) * ROW * 3
    floats += d.curtains.count * 4 * 6
  }
  const keys = new Int32Array(dirty.length * KEY_INTS), data = new Float32Array(floats)
  let o = 0
  for (let k = 0; k < dirty.length; k++) {
    const key = dirty[k]!, cc = key % n, d = view.column(cc, (key - cc) / n)
    keys[k * KEY_INTS] = key
    if (!d) { keys[k * KEY_INTS + 1] = 32; keys[k * KEY_INTS + 2] = -1; keys[k * KEY_INTS + 3] = -1; continue }
    keys[k * KEY_INTS + 1] = d.rowLo; keys[k * KEY_INTS + 2] = d.rowHi
    if (d.rowLo <= d.rowHi) {
      const a = d.rowLo * ROW, b = (d.rowHi + 1) * ROW
      data.set(d.hPrev.subarray(a, b), o); o += b - a
      data.set(d.hCur.subarray(a, b), o); o += b - a
      data.set(d.info.subarray(a, b), o); o += b - a
      d.rowLo = 32; d.rowHi = -1
    }
    const cs = d.curtains, m = cs.count * 4
    keys[k * KEY_INTS + 3] = cs.count
    for (const arr of [cs.prev, cs.cur, cs.reach, cs.thick, cs.flare, cs.info]) { data.set(arr.subarray(0, m), o); o += m }
  }
  return { keys, data }
}

/** The water view's side of #2: applies requests in order and packs what changed. Runs in the water worker, or in-thread. */
export class WaterHost {
  readonly view: SurfaceView
  constructor(size: WorldSize, b: WaterBuffers, light: (x: number, y: number, z: number) => number, stepHz: number, surfaces: DrawnSurfaces) {
    this.view = new SurfaceView(size, b, light, stepHz)
    this.view.surfaces = surfaces
  }

  handle(req: WaterRequest): WaterReply {
    const t0 = performance.now()
    const applied = req.water ? this.view.apply(req.water, req.shown) : false
    for (let i = 0; i < req.relight.length; i += 3) this.view.relight(req.relight[i]!, req.relight[i + 1]!, req.relight[i + 2]!)
    const { keys, data } = packDirty(this.view)
    return { type: 'result', id: req.id, tick: req.tick, applied, hostMs: performance.now() - t0, keys, data }
  }
}
