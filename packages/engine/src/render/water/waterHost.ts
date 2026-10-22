import type { WaterTick } from '../../sim/water/publish.ts'
import type { WorldSize } from '../../world/layout.ts'
import type { WaterBuffers } from '../../world/waterBuffers.ts'
import { SURFACE_ATTRIBUTES, SurfaceView, type DrawnSurfaces } from './surfaceView.ts'

/** One tick for the host: its publish (null: none) and the light ranges [cc, y0, y1]* to re-read after it. */
export interface WaterEntry { tick: number; water: WaterTick | null; relight: number[] }
/**
 * Main thread → water host: every tick queued since the last reply, in order (spec 4.1). `shown` is the alpha on screen
 * when it was sent: the first publish starts from it, each one after an applied publish from 0.
 */
export interface WaterRequest { type: 'apply'; id: number; shown: number; entries: WaterEntry[] }
/** Water host → main thread: per entry, whether its publish was applied; the host's cost (ms); the data of every key that changed (packDirty). */
export interface WaterReply { type: 'result'; id: number; applied: boolean[]; hostMs: number; keys: Int32Array; data: Float32Array }

/** Floats per row of a ColumnData array: 32 instances × 4. */
const ROW = 128
/** Ints per key in WaterReply.keys. */
export const KEY_INTS = 4

/**
 * Takes the view's dirty keys and packs what the renderer reads: per key [key, rowLo, rowHi, curtain count] (count −1: the
 * key has no data), then in `data`, key by key, rows rowLo..rowHi of SURFACE_ATTRIBUTES (none when rowLo > rowHi), then
 * the first count × 4 floats of the six curtain arrays (prev, cur, reach, thick, flare, info). Resets each key's row range,
 * as WaterSurface.sync does when it uploads.
 */
export function packDirty(view: SurfaceView): { keys: Int32Array; data: Float32Array } {
  const dirty = view.takeDirty(), n = view.ccCount
  let floats = 0
  for (const key of dirty) {
    const cc = key % n, d = view.column(cc, (key - cc) / n)
    if (!d) continue
    if (d.rowLo <= d.rowHi) floats += (d.rowHi - d.rowLo + 1) * ROW * SURFACE_ATTRIBUTES.length
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
      for (const arr of d.arrays) { data.set(arr.subarray(a, b), o); o += b - a }
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
  /** Whether the batch's last tick may catch up from the newest buffer (SurfaceView.apply): in the worker, not in-thread. */
  private readonly catchUp: boolean
  constructor(size: WorldSize, b: WaterBuffers, light: (x: number, y: number, z: number) => number, stepHz: number, surfaces: DrawnSurfaces, catchUp = false) {
    this.view = new SurfaceView(size, b, light, stepHz)
    this.view.surfaces = surfaces
    this.catchUp = catchUp
  }

  /**
   * Applies the entries in order, as one-entry requests a round trip apart would (no frame between them): after an applied
   * publish the next starts from alpha 0. Packs once, so the reply carries every key any entry changed, at its final data.
   * With `catchUp`, the last publish of the batch may read the newest buffer when its own was reused; earlier stale ones defer.
   */
  handle(req: WaterRequest): WaterReply {
    const t0 = performance.now()
    const applied: boolean[] = []
    let shown = req.shown, last = -1
    req.entries.forEach((e, i) => { if (e.water) last = i })
    for (const [i, e] of req.entries.entries()) {
      const a = e.water ? this.view.apply(e.water, shown, this.catchUp && i === last) : false
      if (a) shown = 0
      for (let i = 0; i < e.relight.length; i += 3) this.view.relight(e.relight[i]!, e.relight[i + 1]!, e.relight[i + 2]!)
      applied.push(a)
    }
    const { keys, data } = packDirty(this.view)
    return { type: 'result', id: req.id, applied, hostMs: performance.now() - t0, keys, data }
  }
}
