import { RANKS } from '../../sim/water/constants.ts'
import type { WorldSize } from '../../world/layout.ts'
import { SUB, type WaterBuffers } from '../../world/waterBuffers.ts'
import { shows } from './surfaceMesh.ts'
import { ColumnData, NO_SLOT, drawnSurfaces, type DrawnSurfaces } from './surfaceView.ts'
import { KEY_INTS, type WaterReply } from './waterHost.ts'

/** What the renderer and the edit ripples read of the water: SurfaceView in-thread, WaterMirror beside a water host. */
export interface SurfaceSource {
  readonly ccCount: number
  readonly cx: number
  column(cc: number, r?: number): ColumnData | undefined
  takeDirty(): number[]
  surfaceNear(x: number, z: number, y: number): number | null
}

const ROW = 128
const PER_SUB = 1 / SUB
function byIndex(a: number, b: number): number { return a - b }

/**
 * The main thread's copy of the water view's draw data (4a-r2 #2): ColumnData filled from WaterReply copies, the dirty keys
 * for WaterSurface, and synchronous surface queries over the shared DrawnSurfaces the host writes.
 */
export class WaterMirror implements SurfaceSource {
  readonly sx: number
  readonly sz: number
  readonly cx: number
  readonly ccCount: number
  readonly surfaces: DrawnSurfaces
  private readonly floor: Int16Array
  private readonly data: (ColumnData | undefined)[][]
  private readonly dirtyFlag: Uint8Array
  private dirty: number[] = []
  private spare: number[] = []

  constructor(size: WorldSize, b: WaterBuffers) {
    this.sx = size[0]
    this.sz = size[2]
    this.cx = this.sx >> 5
    this.ccCount = this.cx * (this.sz >> 5)
    this.surfaces = drawnSurfaces(this.sx * this.sz)
    this.floor = new Int16Array(b.floor)
    this.data = Array.from({ length: RANKS }, () => new Array<ColumnData | undefined>(this.ccCount))
    this.dirtyFlag = new Uint8Array(this.ccCount * RANKS)
  }

  column(cc: number, r = 0): ColumnData | undefined { return this.data[r]![cc] }

  /** As SurfaceView.takeDirty: keys changed since the last call, in index order; the array is reused. */
  takeDirty(): number[] {
    const out = this.dirty
    if (out.length === 0) return out
    out.sort(byIndex)
    for (const k of out) this.dirtyFlag[k] = 0
    this.dirty = this.spare
    this.dirty.length = 0
    this.spare = out
    return out
  }

  /** Copies a reply's packed keys (packDirty) into the ColumnData the renderer uploads, marking their rows and keys. */
  copy(reply: WaterReply): void {
    const keys = reply.keys, src = reply.data
    let o = 0
    for (let k = 0; k < keys.length; k += KEY_INTS) {
      const key = keys[k]!, lo = keys[k + 1]!, hi = keys[k + 2]!, count = keys[k + 3]!
      if (count < 0) continue
      const cc = key % this.ccCount, r = (key - cc) / this.ccCount
      let d = this.data[r]![cc]
      if (!d) { d = new ColumnData(); this.data[r]![cc] = d }
      if (lo <= hi) {
        const a = lo * ROW, len = (hi - lo + 1) * ROW
        d.hPrev.set(src.subarray(o, o + len), a); o += len
        d.hCur.set(src.subarray(o, o + len), a); o += len
        d.info.set(src.subarray(o, o + len), a); o += len
        d.mark(lo); d.mark(hi)
      }
      const cs = d.curtains, m = count * 4
      cs.reserve(count)
      cs.count = count
      for (const arr of [cs.prev, cs.cur, cs.reach, cs.thick, cs.flare, cs.info]) { arr.set(src.subarray(o, o + m)); o += m }
      if (this.dirtyFlag[key] === 0) { this.dirtyFlag[key] = 1; this.dirty.push(key) }
    }
  }

  /** Forgets everything drawn (a lost worker): every quad hidden and every curtain gone until the next copies, surfaces back to their start. */
  reset(): void {
    for (let r = 0; r < RANKS; r++) for (let cc = 0; cc < this.ccCount; cc++) {
      const d = this.data[r]![cc]
      if (!d) continue
      d.info.fill(-1)
      d.curtains.count = 0
      d.mark(0); d.mark(31)
      const key = r * this.ccCount + cc
      if (this.dirtyFlag[key] === 0) { this.dirtyFlag[key] = 1; this.dirty.push(key) }
    }
    const v = this.surfaces.value
    v.fill(NO_SLOT)
    for (let c = 0; c < this.sx * this.sz; c++) v[c * RANKS] = -1
  }

  /** As SurfaceView.surfaceAt, from the drawn surfaces. */
  surfaceAt(x: number, z: number): number | null {
    if (x < 0 || z < 0 || x >= this.sx || z >= this.sz) return null
    const c = x + z * this.sx, v = this.surfaces.value[c * RANKS]!
    return shows(v, this.floor[c]!) ? v * PER_SUB : null
  }

  /** As SurfaceView.surfaceNear, from the drawn surfaces. */
  surfaceNear(x: number, z: number, y: number): number | null {
    if (x < 0 || z < 0 || x >= this.sx || z >= this.sz) return null
    const c = x + z * this.sx, value = this.surfaces.value, floor = this.surfaces.floor
    let best: number | null = null
    for (let r = 0; r < RANKS; r++) {
      const v = value[c * RANKS + r]!
      if (r > 0 && v === NO_SLOT) continue
      const f = r === 0 ? this.floor[c]! : floor[c * (RANKS - 1) + r - 1]!
      if (!shows(v, f)) continue
      const s = v * PER_SUB
      if (Math.abs(s - y) <= 2 && (best === null || Math.abs(s - y) < Math.abs(best - y))) best = s
    }
    return best
  }
}
