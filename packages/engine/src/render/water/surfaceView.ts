import { RANKS, TILE } from '../../sim/water/constants.ts'
import { mergeTiles, type WaterTick } from '../../sim/water/publish.ts'
import type { WorldSize } from '../../world/layout.ts'
import { SUB, type WaterBuffers } from '../../world/waterBuffers.ts'
import { LayerStore } from './layerStore.ts'
import { hit, patch, resolve, type SlotSource } from './slotPatch.ts'
import {
  ARC_COLUMNS, ARC_GAP, BODY_MAX, CURTAIN_BOTTOM, CURTAIN_TOP, DIR_X, DIR_Z, END_X, END_Z, FLARE_FADE, FLARE_MAX, JOIN, OUTSIDE,
  SINK, boreWhite, bodyThickness, curtainAt, effective, exitSpeed, flareAmount, flareCode, flareMargin, flareOpen, froude, layArc,
  layBody, layLip, level, lipCode, localOf, packFlux, quantizeFlow, shows, splashCode, splashHalf, surfaceWhite, vertexShares,
} from './surfaceMesh.ts'

/**
 * The curtains of one chunk column, per curtain:
 * - `prev`, `cur` (4 floats): (top A, top B, foot A, foot B) heights in blocks;
 * - `reach`, `thick`, `flare` (4 floats each): per end, (A, B) of the previous step then (A, B) of the current one: how far
 *   (blocks) it lands past ARC_GAP in front of its wall, how thick its body is behind the arc, and how far (blocks, at the
 *   foot) it widens sideways and how open it is (flareCode: a free end, with a side face, or one shared with the curtain beside it);
 * - `info` (4 floats): (lx, lz, dir + 4 × (light + 256 × water), packFlux(flux, splash A, splash B)), `water` flagging (bit 0
 *   end A, bit 1 end B) the ends that land on drawn water, where the splash goes; a splash byte holds its width and the slope
 *   of the water under it (splashCode).
 */
export class Curtains {
  count = 0
  prev = new Float32Array(64)
  cur = new Float32Array(64)
  reach = new Float32Array(64)
  thick = new Float32Array(64)
  flare = new Float32Array(64)
  info = new Float32Array(64)
  /** Bumped whenever the arrays are replaced: the renderer then rebuilds its attributes. */
  generation = 0

  reserve(n: number): void {
    if (n * 4 <= this.prev.length) return
    let cap = this.prev.length
    while (cap < n * 4) cap *= 2
    const grow = (a: Float32Array, n: number): Float32Array<ArrayBuffer> => { const b = new Float32Array(n); b.set(a); return b }
    this.prev = grow(this.prev, cap)
    this.cur = grow(this.cur, cap)
    this.reach = grow(this.reach, cap)
    this.thick = grow(this.thick, cap)
    this.flare = grow(this.flare, cap)
    this.info = grow(this.info, cap)
    this.generation++
  }
}

/** Instance data of one chunk column: 32 × 32 quads, instance lx + lz × 32, 4 floats each. */
export class ColumnData {
  /** Corner heights (blocks; corners (−x,−z) (+x,−z) (+x,+z) (−x,+z)) of the previous and the current step. */
  readonly hPrev = new Float32Array(4096)
  readonly hCur = new Float32Array(4096)
  /** Flow x, flow z, depth (blocks), packed light (sky × 16 + block + 256 × white water); a negative packed value hides the quad. */
  readonly info = new Float32Array(4096).fill(-1)
  /** Rows (lz) changed since the renderer last took this column; rowLo > rowHi when none. */
  rowLo = 32
  rowHi = -1
  readonly curtains = new Curtains()
  /** Per column, its curtain directions: bit dir when the previous step hangs one there, bit 4 + dir when the current does. */
  readonly curtainMask = new Uint8Array(1024)

  mark(lz: number): void {
    if (lz < this.rowLo) this.rowLo = lz
    if (lz > this.rowHi) this.rowHi = lz
  }
}

/** 1 / SUB: a power of two, so multiplying by it is exact (and cheaper than dividing). */
const PER_SUB = 1 / SUB

/** Columns from a curtain's column to the farthest it can land on: its neighbour, then up to ARC_REACH (+ ARC_GAP) more. */
const ARC_SPAN = ARC_COLUMNS

/** Vertices along one side of a tile plus its one-column ring, and columns along one side of those plus a halo. */
const VERTICES = TILE + 3
const HALO = TILE + 4

function byIndex(a: number, b: number): number { return a - b }

/**
 * The main thread's copy of the heightfield (spec §5 Data path): reads published tiles, keeps the previous and current step,
 * and turns them into per-column instance data and curtains. Pure: no three.js, Node-testable.
 */
export class SurfaceView {
  readonly sx: number
  readonly sz: number
  readonly n: number
  /** Chunk columns along x and z, and in all (a dirty key is r × ccCount + cc: chunk column cc of draw layer r). */
  readonly cx: number
  readonly cz: number
  readonly ccCount: number
  /** The slots of ranks 0–3 from the ticks' layer records (3d). */
  readonly layers: LayerStore
  /** Tests: refresh every tile through the layered path (plan decision 14's differential test). */
  forceLayered = false
  /** Encoded surfaces (WaterBuffers.surface) of the previous and the current step. */
  readonly prev: Int32Array
  readonly cur: Int32Array
  /** Water moved last step through each column's +x and +z edges (1/SUB block per step). */
  readonly fluxX: Int16Array
  readonly fluxZ: Int16Array
  private readonly surface: Int32Array
  private readonly flux: Int16Array
  private readonly stamp: Int32Array
  private readonly floor: Int16Array
  private readonly fenceWord = new Int32Array(new SharedArrayBuffer(4))
  private readonly tx: number
  private readonly seen: Uint8Array
  /** Tiles of ticks that could not be read, to read from the next tick's buffer. */
  private pending: readonly number[] = []
  /** Tiles read through a recovery: read once more at the next apply, so they settle (prev = cur) like any other tile. */
  private again: readonly number[] = []
  /** Per draw layer r, per chunk column. */
  private readonly data: (ColumnData | undefined)[][]
  /** Per tile: the epoch of the apply that changed its slots. */
  private readonly slotChanged: Uint16Array
  /** The layered path's scratch: a slot's 3 × 3 (current and previous step) and one vertex's shares. */
  private readonly pC = new Int32Array(9)
  private readonly pP = new Int32Array(9)
  private readonly vtmp = new Float32Array(4)
  private readonly src: SlotSource
  private readonly light: (x: number, y: number, z: number) => number
  private readonly stepHz: number
  private scratchS = new Int32Array(0)
  private scratchF = new Int16Array(0)
  /** Per apply (`epoch`): the columns and tiles whose data changed, and the columns already refreshed. */
  private epoch = 0
  private readonly changed: Uint16Array
  private readonly refreshed: Uint16Array
  private readonly tileChanged: Uint16Array
  /** Per tile: listed this apply, seen for the first time this apply (epochs), and whether every column has prev = cur. */
  private readonly tileListed: Uint16Array
  private readonly tileFresh: Uint16Array
  private readonly tileSettled: Uint8Array
  /** The chunk column of the last refreshed column (already marked dirty and touched this apply). */
  private lastCc = -1
  /** Keys (r × ccCount + cc) whose curtains are rebuilt at the end of this apply. */
  private readonly touchedFlag: Uint8Array
  private readonly touched: number[] = []
  /** Keys changed since the renderer last took them; `spare` is the list handed out by the last takeDirty. */
  private readonly dirtyFlag: Uint8Array
  private dirty: number[] = []
  private spare: number[] = []
  /** The region being refreshed: effective values (see `effective`) of its columns and a one-column halo… */
  private readonly eP = new Int32Array(HALO * HALO)
  private readonly eC = new Int32Array(HALO * HALO)
  /** …its vertices' heights (4 per vertex, see vertexShares) and smoothness (bit 0 previous step, bit 1 current). */
  private readonly vPrev = new Float32Array(VERTICES * VERTICES * 4)
  private readonly vCur = new Float32Array(VERTICES * VERTICES * 4)
  private readonly smooth = new Uint8Array(VERTICES * VERTICES)
  /** The alpha (0–1) the surface is drawn at while an apply runs; negative: none given (the previous step is computed). */
  private shown = -1
  /**
   * Per curtain key (column × 4 + dir) of the chunk column being rebuilt: its heights and reach as drawn (CARRY floats), if
   * it had one (tag = token).
   */
  private readonly carryTag = new Int32Array(4096)
  private readonly carryVal = new Float32Array(4096 * CARRY)
  private carryToken = 0
  /**
   * Alpha mode (apply given `shown`): the columns the last apply left drawn with hPrev ≠ hCur, and the chunk columns with
   * such a curtain. Their tiles may never be listed again, so each apply carries them on to where they are drawn
   * (settleRest) until they reach their end; otherwise every later apply, resetting alpha, would draw them back.
   */
  private moving: number[] = []
  private nextMoving: number[] = []
  /** Per slot key (c × RANKS + r): the epoch of the apply that put it in nextMoving (moving lists hold slot keys). */
  private readonly movingMark: Uint16Array
  private curtainsMoving: number[] = []
  /** Scratch for `layEnd` (see layArc): the columns along a curtain end's side, and the arc laid over them. */
  private readonly levels = new Float64Array(ARC_COLUMNS)
  private readonly nearH = new Float64Array(ARC_COLUMNS)
  private readonly farH = new Float64Array(ARC_COLUMNS)
  /** …the ground (blocks) under those columns and under the row beside the end, and the end's laid result (see layEnd). */
  private readonly bedH = new Float64Array(ARC_COLUMNS)
  private readonly sideH = new Float64Array(ARC_COLUMNS)
  private readonly arc = new Float64Array(7)
  /** The corners (blocks) on the end's line of the column groundBeside last looked at, and the splash bytes of the ends laid last. */
  private besideNear = 0
  private besideFar = 0
  private readonly endSplash = new Int32Array(2)
  /** The current step's brink depth of each end (layEnd arc[6]), for cInfo.x / .y. */
  private readonly endLip = new Float64Array(2)

  /** `light(x, y, z)`: packed voxel light (sky | block << 4). `stepHz`: water steps per second (the tick rate). */
  constructor(size: WorldSize, b: WaterBuffers, light: (x: number, y: number, z: number) => number, stepHz = 20) {
    this.sx = size[0]
    this.sz = size[2]
    this.n = this.sx * this.sz
    this.cx = this.sx >> 5
    this.cz = this.sz >> 5
    this.prev = new Int32Array(this.n).fill(-1)
    this.cur = new Int32Array(this.n).fill(-1)
    this.fluxX = new Int16Array(this.n)
    this.fluxZ = new Int16Array(this.n)
    this.surface = new Int32Array(b.surface)
    this.flux = new Int16Array(b.flux)
    this.stamp = new Int32Array(b.stamp)
    this.floor = new Int16Array(b.floor)
    this.tx = this.sx / TILE
    this.seen = new Uint8Array(this.tx * (this.sz / TILE))
    this.ccCount = this.cx * this.cz
    this.data = Array.from({ length: RANKS }, () => new Array<ColumnData | undefined>(this.ccCount))
    this.layers = new LayerStore(this.sx, this.sz)
    const view = this
    this.src = {
      sx: this.sx, sz: this.sz,
      value: (c, r, cur) => (r === 0 ? (cur ? view.cur[c]! : view.prev[c]!) : cur ? view.layers.cur(c, r) : view.layers.prev(c, r)),
      floor: (c, r) => (r === 0 ? view.floor[c]! : view.layers.floor(c, r)),
      ceil: (c, r) => (r === 0 ? 0x7fff : view.layers.ceil(c, r)),
      link: (c, r, dir) => view.layers.link(c, r, dir),
    }
    this.slotChanged = new Uint16Array(this.seen.length)
    this.light = light
    this.stepHz = stepHz
    this.changed = new Uint16Array(this.n)
    this.refreshed = new Uint16Array(this.n)
    this.tileChanged = new Uint16Array(this.seen.length)
    this.tileListed = new Uint16Array(this.seen.length)
    this.tileFresh = new Uint16Array(this.seen.length)
    this.movingMark = new Uint16Array(this.n * RANKS)
    this.tileSettled = new Uint8Array(this.seen.length).fill(1)
    this.touchedFlag = new Uint8Array(this.ccCount * RANKS)
    this.dirtyFlag = new Uint8Array(this.ccCount * RANKS)
  }

  /** Chunk column cc's instance data in draw layer r. */
  column(cc: number, r = 0): ColumnData | undefined { return this.data[r]![cc] }

  /** The water surface (blocks) of column (x, z) as last published, or null where none is drawn (dry, too shallow, outside). */
  surfaceAt(x: number, z: number): number | null {
    if (x < 0 || z < 0 || x >= this.sx || z >= this.sz) return null
    const c = x + z * this.sx, v = this.cur[c]!
    return shows(v, this.floor[c]!) ? v * PER_SUB : null
  }

  /**
   * Keys (r × ccCount + cc) whose data changed since the last call, in index order. The array is reused: it stays valid until
   * the next call, and the caller must not keep or modify it.
   */
  takeDirty(): number[] {
    const out = this.dirty
    if (out.length === 0) return out
    out.sort(byIndex)
    for (const cc of out) this.dirtyFlag[cc] = 0
    this.dirty = this.spare
    this.dirty.length = 0
    this.spare = out
    return out
  }

  /**
   * Reads a tick's tiles (and any still pending) from shared memory. If the publish's buffer was reused before or while we
   * read it, nothing is applied: the tiles wait for the next tick, whose buffer holds them complete. Returns whether it applied.
   *
   * `shown`: the alpha the surface is drawn at now (waterAlpha). Given, each refreshed quad and curtain starts its new step
   * from where it is drawn (hPrev ← mix(hPrev, hCur, shown)) rather than from the previous step, so a publish that comes
   * before the step was drawn to its end does not jump; the caller then draws at alpha 0 to show the same heights.
   */
  apply(t: WaterTick, shown?: number): boolean {
    // No tile list is ever modified: mergeTiles may hand back one of its inputs, and the publisher keeps its own.
    const recovering = this.pending.length > 0
    const tiles = mergeTiles(mergeTiles(t.tiles, this.pending), this.again)
    const p = t.parity
    // Each tick's records are complete per tile: staged even when this buffer is lost, the latest wins at the commit.
    if (t.layers) this.layers.stage(t.layers)
    if (Atomics.load(this.stamp, p) !== t.seq) return this.defer(tiles)
    const per = TILE * TILE
    if (this.scratchS.length < tiles.length * per) {
      this.scratchS = new Int32Array(tiles.length * per * 2)
      this.scratchF = new Int16Array(tiles.length * per * 4)
    }
    const base = p * this.n
    let k = 0
    for (const tile of tiles) {
      const x0 = (tile % this.tx) * TILE, z0 = Math.floor(tile / this.tx) * TILE
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) {
        const c = x + z * this.sx
        this.scratchS[k] = this.surface[base + c]!
        this.scratchF[2 * k] = this.flux[2 * (base + c)]!
        this.scratchF[2 * k + 1] = this.flux[2 * (base + c) + 1]!
        k++
      }
    }
    Atomics.add(this.fenceWord, 0, 0) // orders the copies before the validating load (see WorldReader.fence)
    if (Atomics.load(this.stamp, p) !== t.seq) return this.defer(tiles)
    this.pending = []
    // After a change a tile comes in twice (the writer adds the previous publish's tiles): moving, then settled. Tiles that
    // came in late through this tick may have missed the first, so they are read once more at the next apply.
    this.again = recovering ? tiles : []
    const e = this.nextEpoch()
    k = 0
    for (const tile of tiles) {
      const first = this.seen[tile] === 0
      this.seen[tile] = 1
      let any = false, moving = false
      const x0 = (tile % this.tx) * TILE, z0 = Math.floor(tile / this.tx) * TILE
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) {
        const c = x + z * this.sx, v = this.scratchS[k]!, pv = first ? v : this.cur[c]!
        const fx = this.scratchF[2 * k]!, fz = this.scratchF[2 * k + 1]!
        k++
        if (v !== pv) moving = true
        if (pv === this.prev[c] && v === this.cur[c] && fx === this.fluxX[c] && fz === this.fluxZ[c]) continue
        this.prev[c] = pv
        this.cur[c] = v
        this.fluxX[c] = fx
        this.fluxZ[c] = fz
        this.changed[c] = e
        any = true
      }
      if (this.layers.commit(tile, first)) { any = true; this.slotChanged[tile] = e }
      if (any) this.tileChanged[tile] = e
      this.tileListed[tile] = e
      if (first) this.tileFresh[tile] = e
      this.tileSettled[tile] = moving ? 0 : 1
    }
    this.lastCc = -1
    this.shown = shown ?? -1
    for (const tile of tiles) if (this.tileChanged[tile] === e) this.refreshTile(tile, e)
    const carrying = this.shown >= 0
    if (carrying) this.settleRest(e)
    for (const key of this.touched) {
      this.touchedFlag[key] = 0
      const cc = key % this.ccCount, r = (key - cc) / this.ccCount, d = this.data[r]![cc]
      if (!d) continue
      this.buildCurtains(cc, d, this.shown, r)
      this.markDirty(key)
      if (carrying && settleCurtains(d.curtains)) this.curtainsMoving.push(key)
    }
    this.touched.length = 0
    this.shown = -1
    return true
  }

  /**
   * Re-reads the voxel light of chunk column `cc`'s drawn columns whose light cell (the one apply reads) lies in layers
   * [y0, y1), keeping their white water: for a light change there (a chunk the sim marked dirty), which apply alone would
   * miss on still water. Marks what changed for upload and rebuilds the chunk column's curtains when one changed.
   */
  relight(cc: number, y0: number, y1: number): void {
    const x0 = (cc % this.cx) * 32, z0 = Math.floor(cc / this.cx) * 32
    for (let r = 0; r < RANKS; r++) {
      const d = this.data[r]![cc]
      if (!d) continue
      const info = d.info
      let any = false, curtains = false
      for (let i = 0; i < 1024; i++) {
        const o = i * 4 + 3, packed = info[o]!
        if (packed < 0) continue
        const x = x0 + (i & 31), z = z0 + (i >> 5), c = x + z * this.sx
        if (r > 0 && !this.layers.has(c, r)) continue
        const y = Math.ceil(level(r === 0 ? this.cur[c]! : this.layers.cur(c, r)) * PER_SUB)
        if (y < y0 || y >= y1) continue
        const l = this.light(x, y, z), lit = packed - (packed % 256) + (l & 15) * 16 + (l >> 4)
        if (lit === packed) continue
        info[o] = lit
        d.mark(i >> 5)
        any = true
        if (d.curtainMask[i] !== 0) curtains = true
      }
      if (curtains) this.buildCurtains(cc, d, 0, r) // the heights do not change: every curtain keeps them
      if (any) this.markDirty(r * this.ccCount + cc)
    }
  }

  /**
   * Alpha mode, after the refresh: carries every column the last apply left moving that this one did not refresh to where
   * it is drawn (hPrev ← mix(hPrev, hCur, shown)), snaps the moving columns within SETTLED of their end and keeps the rest
   * for the next apply. The chunk columns of moved quads and of moving curtains are touched: their curtains are rebuilt
   * with the carry.
   */
  private settleRest(e: number): void {
    const a = this.shown, sx = this.sx
    for (const s of this.moving) {
      const c = (s / RANKS) | 0, r = s % RANKS
      if (this.refreshed[c] === e) continue // refreshed: carried already, and listed again if still moving
      const x = c % sx, z = (c - x) / sx, cc = (x >> 5) + (z >> 5) * this.cx, d = this.data[r]![cc], key = r * this.ccCount + cc
      const o = ((x & 31) + (z & 31) * 32) * 4
      if (!d || d.info[o + 3]! < 0) continue
      const hp = d.hPrev, hc = d.hCur
      for (let k = o; k < o + 4; k++) hp[k] = hp[k]! + (hc[k]! - hp[k]!) * a
      d.mark(z & 31)
      this.markDirty(key)
      this.touch(key)
      this.track(c, r)
    }
    const next = this.nextMoving
    let w = 0
    for (const s of next) {
      const c = (s / RANKS) | 0, r = s % RANKS
      const x = c % sx, z = (c - x) / sx, cc = (x >> 5) + (z >> 5) * this.cx, d = this.data[r]![cc]!
      const o = ((x & 31) + (z & 31) * 32) * 4, hp = d.hPrev, hc = d.hCur
      let far = false, apart = false
      for (let k = o; k < o + 4; k++) {
        const g = Math.abs(hc[k]! - hp[k]!)
        if (g >= SETTLED) far = true
        else if (g > 0) apart = true
      }
      if (far) { next[w++] = s; continue }
      if (apart) { hp.set(hc.subarray(o, o + 4), o); d.mark(z & 31); this.markDirty(r * this.ccCount + cc) }
    }
    next.length = w
    this.nextMoving = this.moving
    this.nextMoving.length = 0
    this.moving = next
    for (const cc of this.curtainsMoving) this.touch(cc)
    this.curtainsMoving.length = 0
  }

  /** Alpha mode: lists slot (c, r) (just refreshed or carried, drawn) for the end of this apply's settleRest. */
  private track(c: number, r = 0): void {
    const s = c * RANKS + r
    if (this.movingMark[s] === this.epoch) return
    this.movingMark[s] = this.epoch
    this.nextMoving.push(s)
  }

  private defer(tiles: readonly number[]): false {
    this.pending = tiles
    this.again = []
    return false
  }

  private nextEpoch(): number {
    if (++this.epoch > 0xffff) {
      this.changed.fill(0)
      this.refreshed.fill(0)
      this.tileChanged.fill(0)
      this.tileListed.fill(0)
      this.tileFresh.fill(0)
      this.movingMark.fill(0)
      this.slotChanged.fill(0)
      this.epoch = 1
    }
    return this.epoch
  }

  /** Key r × ccCount + cc (rank 0: the chunk column itself) changed: the renderer takes it at the next takeDirty. */
  private markDirty(key: number): void {
    if (this.dirtyFlag[key] === 0) { this.dirtyFlag[key] = 1; this.dirty.push(key) }
  }

  /** Key r × ccCount + cc: its curtains are rebuilt at the end of this apply. */
  private touch(key: number): void {
    if (this.touchedFlag[key] === 0) { this.touchedFlag[key] = 1; this.touched.push(key) }
  }

  /**
   * Touches the chunk columns of draw layer r within ARC_SPAN of (x, z): those whose curtains may cross or land on it, or
   * share an end with a curtain beside it.
   */
  private touchSpan(x: number, z: number, r = 0): void {
    const xa = Math.max(0, x - ARC_SPAN) >> 5, xb = Math.min(this.sx - 1, x + ARC_SPAN) >> 5
    const za = Math.max(0, z - ARC_SPAN) >> 5, zb = Math.min(this.sz - 1, z + ARC_SPAN) >> 5
    for (let k = za; k <= zb; k++) for (let i = xa; i <= xb; i++) this.touch(r * this.ccCount + i + k * this.cx)
  }

  /**
   * Refreshes the columns of the tile and its one-column ring (their corners see the tile) that this apply's changes reach:
   * those with a changed column among their 3 × 3. A ring side is left to the tile beyond it when that tile changed too, and
   * each column is refreshed at most once per apply. Every vertex of the region is grouped once per step, or only for the
   * current step when the region is aligned (see `aligned`).
   */
  private refreshTile(tile: number, e: number): void {
    if (this.forceLayered || this.layers.layeredAround(tile)) { this.refreshLayered(tile, e); return }
    const tw = this.tx, th = this.seen.length / tw, tx = tile % tw, tz = (tile - tx) / tw
    const x0 = tx * TILE, z0 = tz * TILE
    const xa = tx > 0 && this.tileChanged[tile - 1] !== e ? x0 - 1 : x0
    const xb = tx + 1 < tw && this.tileChanged[tile + 1] !== e ? x0 + TILE + 1 : x0 + TILE
    const za = tz > 0 && this.tileChanged[tile - tw] !== e ? z0 - 1 : z0
    const zb = tz + 1 < th && this.tileChanged[tile + tw] !== e ? z0 + TILE + 1 : z0 + TILE
    const sx = this.sx, sz = this.sz, hw = xb - xa + 2, vw = xb - xa + 1
    const eP = this.eP, eC = this.eC, vP = this.vPrev, vC = this.vCur, smooth = this.smooth
    const aligned = this.aligned(tx, tz, e)
    // Effective values of the region's columns and a one-column halo around them.
    let h = 0
    for (let z = za - 1; z <= zb; z++) for (let x = xa - 1; x <= xb; x++, h++) {
      if (x < 0 || z < 0 || x >= sx || z >= sz) { eP[h] = OUTSIDE; eC[h] = OUTSIDE; continue }
      const c = x + z * sx, f = this.floor[c]!
      if (!aligned) eP[h] = effective(this.prev[c]!, f)
      eC[h] = effective(this.cur[c]!, f)
    }
    // Vertex (xa + i, za + k) has the columns of halo cells (i, k), (i + 1, k), (i, k + 1), (i + 1, k + 1) around it.
    let vi = 0
    for (let k = 0; k <= zb - za; k++) for (let i = 0; i < vw; i++, vi++) {
      const a = i + k * hw, b = a + hw
      smooth[vi] = (shares(eC, a, b, vC, vi * 4) ? 2 : 0) | (!aligned && shares(eP, a, b, vP, vi * 4) ? 1 : 0)
    }
    for (let z = za; z < zb; z++) for (let x = xa; x < xb; x++) {
      const c = x + z * sx
      if (this.refreshed[c] === e || !this.near(x, z, e)) continue
      this.refreshed[c] = e
      this.refreshColumn(x, z, x - xa + 1 + (z - za + 1) * hw, hw, x - xa + (z - za) * vw, vw, aligned)
    }
  }

  /**
   * Whether every column around tile (tx, tz) (the tile and its 8 neighbours) has prev = the cur of the last apply: listed
   * this apply but not for the first time, or not listed and settled. Then each column's previous step is exactly what the
   * last apply drew as its current step, and is copied instead of recomputed.
   */
  private aligned(tx: number, tz: number, e: number): boolean {
    const tw = this.tx, th = this.seen.length / tw
    const xa = Math.max(0, tx - 1), xb = Math.min(tw - 1, tx + 1), za = Math.max(0, tz - 1), zb = Math.min(th - 1, tz + 1)
    for (let z = za; z <= zb; z++) for (let x = xa; x <= xb; x++) {
      const t = x + z * tw
      if (this.tileFresh[t] === e || (this.tileListed[t] !== e && this.tileSettled[t] === 0)) return false
    }
    return true
  }

  /** Whether a column of the 3 × 3 around (x, z) changed this apply. */
  private near(x: number, z: number, e: number): boolean {
    const sx = this.sx
    const xa = x > 0 ? x - 1 : x, xb = x + 1 < sx ? x + 1 : x
    const za = z > 0 ? z - 1 : z, zb = z + 1 < this.sz ? z + 1 : z
    for (let j = za; j <= zb; j++) for (let i = xa; i <= xb; i++) if (this.changed[i + j * sx] === e) return true
    return false
  }

  /** The tile and its ring as refreshTile, every column at every rank, neighbours through links (plan decision 14). */
  private refreshLayered(tile: number, e: number): void {
    const tw = this.tx, th = this.seen.length / tw, tx = tile % tw, tz = (tile - tx) / tw
    const x0 = tx * TILE, z0 = tz * TILE
    const xa = tx > 0 && this.tileChanged[tile - 1] !== e ? x0 - 1 : x0
    const xb = tx + 1 < tw && this.tileChanged[tile + 1] !== e ? x0 + TILE + 1 : x0 + TILE
    const za = tz > 0 && this.tileChanged[tile - tw] !== e ? z0 - 1 : z0
    const zb = tz + 1 < th && this.tileChanged[tile + tw] !== e ? z0 + TILE + 1 : z0 + TILE
    for (let z = za; z < zb; z++) for (let x = xa; x < xb; x++) {
      const c = x + z * this.sx
      if (this.refreshed[c] === e || !this.nearLayered(x, z, e)) continue
      this.refreshed[c] = e
      for (let r = 0; r < RANKS; r++) {
        if (r === 0 || this.layers.has(c, r)) this.refreshSlot(x, z, r)
        else this.clearSlot(x, z, r)
      }
    }
  }

  /**
   * near(), or anywhere in a tile whose slots changed this apply (a slot's change does not mark its column). With no slot
   * change this is near() exactly, so on a world without layers the layered path refreshes the same columns as the fast one.
   */
  private nearLayered(x: number, z: number, e: number): boolean {
    return this.near(x, z, e) || this.slotChanged[(x >> 4) + (z >> 4) * this.tx] === e
  }

  /** A slot that is gone: its quad is hidden. */
  private clearSlot(x: number, z: number, r: number): void {
    const cc = (x >> 5) + (z >> 5) * this.cx, d = this.data[r]![cc]
    if (!d) return
    const i = (x & 31) + (z & 31) * 32
    if (d.info[i * 4 + 3]! < 0) return
    d.info[i * 4 + 3] = -1
    d.curtainMask[i] = 0
    d.mark(z & 31)
    this.markDirty(r * this.ccCount + cc)
    this.touch(r * this.ccCount + cc)
  }

  /**
   * refreshColumn for slot (x, z, r) on its 3 × 3 through the links (patch): its corners are its shares of its four vertices
   * (vertexShares over each 2 × 2 block, own quadrants 3, 2, 0, 1), and its flow, white water, light and curtain bits as
   * refreshColumn computes them. With default links every number equals refreshColumn's (the differential test).
   */
  private refreshSlot(x: number, z: number, r: number): void {
    const sx = this.sx, c = x + z * sx, cc = (x >> 5) + (z >> 5) * this.cx, src = this.src, key = r * this.ccCount + cc
    const pv = src.value(c, r, false), fl = src.floor(c, r), pC = this.pC, pP = this.pP
    patch(src, x, z, r, true, pC)
    patch(src, x, z, r, false, pP)
    const ec = pC[4]!, was = shows(pv, fl), drawn = was || ec >= 0
    const lx = x & 31, lz = z & 31, i = lx + lz * 32, o = i * 4
    if (lx < ARC_SPAN || lx >= 32 - ARC_SPAN || lz < ARC_SPAN || lz >= 32 - ARC_SPAN) this.touchSpan(x, z, r)
    let d = this.data[r]![cc]
    if (!d) {
      if (!drawn) return
      d = new ColumnData()
      this.data[r]![cc] = d
    }
    d.mark(lz)
    this.markDirty(key)
    this.touch(key)
    if (!drawn) { d.info[o + 3] = -1; d.curtainMask[i] = 0; return }
    const hp = d.hPrev, hc = d.hCur, a = this.shown, onScreen = a >= 0 && d.info[o + 3]! >= 0
    const s0 = hp[o]! + (hc[o]! - hp[o]!) * a, s1 = hp[o + 1]! + (hc[o + 1]! - hp[o + 1]!) * a
    const s2 = hp[o + 2]! + (hc[o + 2]! - hp[o + 2]!) * a, s3 = hp[o + 3]! + (hc[o + 3]! - hp[o + 3]!) * a
    let smoothP = true, smoothC = true
    for (let k = 0; k < 4; k++) {
      smoothP = patchCorner(pP, k, hp, o, this.vtmp) && smoothP
      smoothC = patchCorner(pC, k, hc, o, this.vtmp) && smoothC
    }
    if (onScreen) { hp[o] = s0; hp[o + 1] = s1; hp[o + 2] = s2; hp[o + 3] = s3 }
    const prevBits = smoothP ? 0 : edgeBits(pP, 4, 3)
    const s = level(src.value(c, r, true)), depth = Math.max(0, s - fl * SUB)
    const east = r === 0 ? this.fluxX[c]! : this.layers.fluxX(c, r), south = r === 0 ? this.fluxZ[c]! : this.layers.fluxZ(c, r)
    resolve(src, x, z, r, 1, true)
    const west = hit.c < 0 ? 0 : hit.r === 0 ? this.fluxX[hit.c]! : this.layers.fluxX(hit.c, hit.r)
    resolve(src, x, z, r, 3, true)
    const north = hit.c < 0 ? 0 : hit.r === 0 ? this.fluxZ[hit.c]! : this.layers.fluxZ(hit.c, hit.r)
    const k = this.stepHz / (2 * Math.max(depth, SUB / 8))
    const fr = froude(quantizeFlow((west + east) * k, (north + south) * k, d.info, o), depth * PER_SUB)
    let white = surfaceWhite(fr)
    let curBits = 0
    if (!smoothC) {
      curBits = edgeBits(pC, 4, 3)
      if (frontIn(pC, 5, ec, east) || frontIn(pC, 3, ec, -west) || frontIn(pC, 7, ec, south) || frontIn(pC, 1, ec, -north)) white = Math.max(white, boreWhite(fr))
    }
    const l = this.light(x, Math.ceil(s * PER_SUB), z)
    d.info[o + 2] = depth * PER_SUB
    d.info[o + 3] = (l & 15) * 16 + (l >> 4) + 256 * white
    d.curtainMask[i] = prevBits | (curBits << 4)
    if (a >= 0) this.track(c, r)
  }

  /**
   * Column (x, z): `h` its halo cell (rows hw wide), `vi` its (−x,−z) vertex (rows vw wide) in the region being refreshed;
   * `aligned`: its previous step is the last apply's current step (see `aligned`).
   */
  private refreshColumn(x: number, z: number, h: number, hw: number, vi: number, vw: number, aligned: boolean): void {
    const sx = this.sx, c = x + z * sx, cc = (x >> 5) + (z >> 5) * this.cx
    const fl = this.floor[c]!, pv = this.prev[c]!, ec = this.eC[h]!
    const was = shows(pv, fl), drawn = was || ec >= 0
    const lx = x & 31, lz = z & 31, i = lx + lz * 32, o = i * 4
    // A curtain depends on its column's 3 × 3, on the columns its ends pass over and land on (up to ARC_SPAN out along its
    // side, drawn or not) and on the curtains beside it (layEnd). Those near the border may hold curtains of another one.
    if (lx < ARC_SPAN || lx >= 32 - ARC_SPAN || lz < ARC_SPAN || lz >= 32 - ARC_SPAN) this.touchSpan(x, z)
    let d = this.data[0]![cc]
    if (!d) {
      if (!drawn) return
      d = new ColumnData()
      this.data[0]![cc] = d
    }
    d.mark(lz)
    if (cc !== this.lastCc) { this.lastCc = cc; this.markDirty(cc); this.touch(cc) }
    if (!drawn) { d.info[o + 3] = -1; d.curtainMask[i] = 0; return }
    // Corner k is this column's share (quadrant 3, 2, 0, 1) of vertex (x, z), (x+1, z), (x+1, z+1), (x, z+1).
    const v0 = vi * 4 + 3, v1 = (vi + 1) * 4 + 2, v2 = (vi + vw + 1) * 4, v3 = (vi + vw) * 4 + 1
    const hp = d.hPrev, hc = d.hCur, vp = this.vPrev, vc = this.vCur, sm = this.smooth
    // A quad on screen starts its new step where it is drawn (see apply).
    const a = this.shown, onScreen = a >= 0 && d.info[o + 3]! >= 0
    const s0 = hp[o]! + (hc[o]! - hp[o]!) * a, s1 = hp[o + 1]! + (hc[o + 1]! - hp[o + 1]!) * a
    const s2 = hp[o + 2]! + (hc[o + 2]! - hp[o + 2]!) * a, s3 = hp[o + 3]! + (hc[o + 3]! - hp[o + 3]!) * a
    let prevBits: number
    if (aligned) {
      // Drawn by the last apply as its current step, with these corners and curtains; or not drawn: at its ground.
      if (was) { hp[o] = hc[o]!; hp[o + 1] = hc[o + 1]!; hp[o + 2] = hc[o + 2]!; hp[o + 3] = hc[o + 3]! } else {
        const g = level(pv) / SUB - SINK
        hp[o] = g; hp[o + 1] = g; hp[o + 2] = g; hp[o + 3] = g
      }
      prevBits = was ? d.curtainMask[i]! >> 4 : 0
    } else {
      hp[o] = vp[v0]!; hp[o + 1] = vp[v1]!; hp[o + 2] = vp[v2]!; hp[o + 3] = vp[v3]!
      // Around four smooth vertices every neighbour is drawn within JOIN: no curtain hangs from or onto c.
      prevBits = (sm[vi]! & sm[vi + 1]! & sm[vi + vw]! & sm[vi + vw + 1]! & 1) !== 0 ? 0 : edgeBits(this.eP, h, hw)
    }
    if (onScreen) { hp[o] = s0; hp[o + 1] = s1; hp[o + 2] = s2; hp[o + 3] = s3 }
    hc[o] = vc[v0]!; hc[o + 1] = vc[v1]!; hc[o + 2] = vc[v2]!; hc[o + 3] = vc[v3]!
    const s = level(this.cur[c]!), depth = Math.max(0, s - fl * SUB)
    const west = x > 0 ? this.fluxX[c - 1]! : 0, east = this.fluxX[c]!
    const north = z > 0 ? this.fluxZ[c - sx]! : 0, south = this.fluxZ[c]!
    // Velocity (blocks per second) = flux through a 1-block edge / depth, × steps per second.
    const k = this.stepHz / (2 * Math.max(depth, SUB / 8))
    const fr = froude(quantizeFlow((west + east) * k, (north + south) * k, d.info, o), depth * PER_SUB)
    let white = surfaceWhite(fr)
    let curBits = 0
    if ((sm[vi]! & sm[vi + 1]! & sm[vi + vw]! & sm[vi + vw + 1]! & 2) === 0) {
      curBits = edgeBits(this.eC, h, hw)
      // White water where c runs onto dry ground (a front), from its Froude number. A curtain falling into c gets none here:
      // its splash whitens the water where its arc lands, which is past c when it is thrown out.
      if (this.front(h + 1, ec, east) || this.front(h - 1, ec, -west) || this.front(h + hw, ec, south) || this.front(h - hw, ec, -north)) {
        white = Math.max(white, boreWhite(fr))
      }
    }
    const l = this.light(x, Math.ceil(s * PER_SUB), z)
    d.info[o + 2] = depth * PER_SUB
    d.info[o + 3] = (l & 15) * 16 + (l >> 4) + 256 * white
    d.curtainMask[i] = prevBits | (curBits << 4)
    if (a >= 0) this.track(c)
  }

  /**
   * Whether a column at effective value ec sending `out` toward halo cell j runs onto dry ground there: j is not drawn and
   * its level lies below ec within JOIN (no wall, no curtain).
   */
  private front(j: number, ec: number, out: number): boolean {
    const ej = this.eC[j]!
    if (out <= 0 || ej >= 0 || ej === OUTSIDE) return false
    const drop = ec - ~ej
    return drop > 0 && drop <= JOIN
  }

  /**
   * Lists a chunk column's curtains from its curtain masks and the corners refreshed this apply. `carry` ≥ 0: a curtain the
   * list already had starts from its heights and reach drawn at alpha `carry` (see apply); negative: from its previous step.
   */
  private buildCurtains(cc: number, d: ColumnData, carry: number, r = 0): void {
    const cs = d.curtains, sx = this.sx, mask = d.curtainMask
    const tag = this.carryTag, val = this.carryVal, token = carry >= 0 ? ++this.carryToken : 0
    if (carry >= 0) {
      for (let k = 0; k < cs.count; k++) {
        const o = k * 4, key = (localOf(cs.info[o]!) + localOf(cs.info[o + 1]!) * 32) * 4 + (cs.info[o + 2]! % 4), v = key * CARRY
        tag[key] = token
        for (let j = 0; j < 4; j++) val[v + j] = cs.prev[o + j]! + (cs.cur[o + j]! - cs.prev[o + j]!) * carry
        for (let e = 0; e < 2; e++) {
          val[v + 4 + e] = cs.reach[o + e]! + (cs.reach[o + 2 + e]! - cs.reach[o + e]!) * carry
          val[v + 6 + e] = cs.thick[o + e]! + (cs.thick[o + 2 + e]! - cs.thick[o + e]!) * carry
          // Openness and widening carry separately: an end moving between shared and free closes or opens its side face.
          const fp = cs.flare[o + e]!, fc = cs.flare[o + 2 + e]!, op = flareOpen(fp), ap = flareAmount(fp)
          val[v + 8 + e] = flareCode(op + (flareOpen(fc) - op) * carry, ap + (flareAmount(fc) - ap) * carry)
        }
      }
    }
    const x0 = (cc % this.cx) * 32, z0 = Math.floor(cc / this.cx) * 32
    let n = 0
    for (let i = 0; i < 1024; i++) {
      const m = mask[i]!
      if (m === 0) continue
      const lx = i & 31, lz = i >> 5, x = x0 + lx, z = z0 + lz, c = x + z * sx, o4 = i * 4
      const packed = d.info[o4 + 3]!
      for (let dir = 0; dir < 4; dir++) {
        const was = ((m >> dir) & 1) === 1, now = ((m >> (dir + 4)) & 1) === 1
        if (!was && !now) continue
        const [ta, tb] = CURTAIN_TOP[dir]!
        const flux = Math.max(0, this.edgeFlux(c, dir)), v = exitSpeed(flux, this.stepHz)
        cs.reserve(n + 1)
        const o = n * 4
        cs.prev[o] = d.hPrev[o4 + ta]!
        cs.prev[o + 1] = d.hPrev[o4 + tb]!
        cs.cur[o] = d.hCur[o4 + ta]!
        cs.cur[o + 1] = d.hCur[o4 + tb]!
        // The edges' fluxes now stand for both steps: the view keeps only the current ones.
        this.lay(cs, o, false, was, x, z, dir, v)
        const water = this.lay(cs, o, true, now, x, z, dir, v)
        const key = i * 4 + dir
        if (token !== 0 && tag[key] === token) {
          for (let j = 0; j < 4; j++) cs.prev[o + j] = val[key * CARRY + j]!
          for (let e = 0; e < 2; e++) {
            cs.reach[o + e] = val[key * CARRY + 4 + e]!
            cs.thick[o + e] = val[key * CARRY + 6 + e]!
            cs.flare[o + e] = val[key * CARRY + 8 + e]!
          }
        }
        cs.info[o] = lipCode(lx, this.endLip[0]!)
        cs.info[o + 1] = lipCode(lz, this.endLip[1]!)
        cs.info[o + 2] = dir + 4 * ((packed % 256) + 256 * water)
        cs.info[o + 3] = packFlux(flux, this.endSplash[0]!, this.endSplash[1]!)
        n++
      }
    }
    cs.count = n
  }

  /**
   * Lays one step of the curtain at cs[o / 4] from column (x, z) through its side `dir`, whose tops (top A, top B) are already
   * in cs.prev / cs.cur (`cur`) [o], [o + 1]: its feet into [o + 2], [o + 3] and its ends' reach, thickness and flare into
   * cs.reach / thick / flare at [o + 2 × cur + end] (layEnd). A curtain absent in the step (`on` false) is rolled up to its
   * top, with no reach, body or flare. Returns which ends land on drawn water (bit 0 end A, bit 1 end B).
   */
  private lay(cs: Curtains, o: number, cur: boolean, on: boolean, x: number, z: number, dir: number, v: number): number {
    const out = cur ? cs.cur : cs.prev, r = cur ? o + 2 : o, a = this.arc
    let water = 0
    for (let end = 0; end < 2; end++) {
      if (!on) {
        out[o + 2 + end] = out[o + end]!; cs.reach[r + end] = 0; cs.thick[r + end] = 0; cs.flare[r + end] = flareCode(1, 0)
        this.endSplash[end] = 0
        this.endLip[end] = 0
        continue
      }
      this.layEnd(out[o + end]!, cur, x, z, dir, end, v)
      cs.reach[r + end] = a[0]!
      out[o + 2 + end] = a[1]!
      cs.thick[r + end] = a[2]!
      cs.flare[r + end] = a[3]!
      water |= a[4]! << end
      this.endSplash[end] = a[5]!
      this.endLip[end] = a[6]!
    }
    return water
  }

  /**
   * Lays end `end` (0 A, 1 B) of the curtain from column (x, z) through side `dir` in a step, from height `top`, into arc:
   * [0] its reach and [1] its foot (layArc), [2] its body's thickness (layBody), [3] its flare, [4] whether it lands on
   * drawn water, [5] its splash byte and [6] its brink depth (layLip): its underside leaves the brink at the column's floor (the
   * higher of both rows' when shared), or at the water below the brink when that is higher. The curtain beside that end on the same side, when one hangs there in the step, shares the end: it is thrown
   * at the mean of both curtains' exit speeds (v is this one's) over the higher of both rows' levels and ground, so both lay
   * the same arc, foot and body there, which do not flare (flareCode(0, 0)). It lands on this row's columns: their corners at the
   * end's line (near and far from the wall) when drawn, their ground otherwise. A free end flares when the row beside it
   * (in the world) is clear of the arc and the body, as far as its flux gives it body.
   */
  private layEnd(top: number, cur: boolean, x: number, z: number, dir: number, end: number, v: number): void {
    const s = cur ? this.cur : this.prev, sx = this.sx, sz = this.sz, dx = DIR_X[dir]!, dz = DIR_Z[dir]!
    const ox = END_X[dir]![end]!, oz = END_Z[dir]![end]!, nx = x + ox, nz = z + oz
    // When the column beside lies in the world, so does its neighbour through `dir` (beside this one's).
    const beside = nx >= 0 && nz >= 0 && nx < sx && nz < sz
    const shared = beside && curtainAt(s, this.floor, nx + nz * sx, nx + dx + (nz + dz) * sx)
    const speed = shared ? (v + exitSpeed(Math.max(0, this.edgeFlux(nx + nz * sx, dir)), this.stepHz)) / 2 : v
    const levels = this.levels, near = this.nearH, far = this.farH, nc = CURTAIN_BOTTOM[dir]![end]!, fc = CURTAIN_TOP[dir]![end]!
    const bed = this.bedH, side = ox + oz * sx, flank = this.sideH, arc = this.arc
    // The corners on the end's line, seen from the row beside it, are that row's other end's.
    const nc2 = CURTAIN_BOTTOM[dir]![1 - end]!, fc2 = CURTAIN_TOP[dir]![1 - end]!
    for (let i = 0; i < ARC_COLUMNS; i++) {
      const ax = x + dx * (i + 1), az = z + dz * (i + 1)
      if (ax < 0 || az < 0 || ax >= sx || az >= sz) { levels[i] = Infinity; near[i] = 0; far[i] = 0; bed[i] = Infinity; flank[i] = Infinity; continue }
      const a = ax + az * sx, w = s[a]!, g = level(w) * PER_SUB
      levels[i] = shared ? Math.max(g, level(s[a + side]!) * PER_SUB) : g
      const da = this.data[0]![(ax >> 5) + (az >> 5) * this.cx]
      if (da !== undefined && shows(w, this.floor[a]!)) {
        const h = cur ? da.hCur : da.hPrev, oa = ((ax & 31) + (az & 31) * 32) * 4
        near[i] = h[oa + nc]!
        far[i] = h[oa + fc]!
        bed[i] = Math.min(this.floor[a]!, near[i]!, far[i]!)
      } else { near[i] = g; far[i] = g; bed[i] = g }
      if (beside) flank[i] = this.groundBeside(s, cur, ax + ox, az + oz, nc2, fc2)
      if (shared) {
        // Both rows lay the end from the higher of their corners too, so the two feet (and bodies) are one.
        near[i] = Math.max(near[i]!, this.besideNear)
        far[i] = Math.max(far[i]!, this.besideFar)
        bed[i] = Math.max(bed[i]!, flank[i]!)
      }
    }
    layArc(speed, top, levels, near, far, arc)
    const c = x + z * sx, brink = shared ? Math.max(this.floor[c]!, this.floor[c + side]!) : this.floor[c]!
    const r = arc[0]!, foot = arc[1]!, lip = layLip(top - Math.max(brink, levels[0]!), top, foot, r, bed)
    const want = bodyThickness(speed), thick = layBody(want, top, foot, r, bed, lip)
    arc[2] = thick
    arc[6] = lip
    // A free end flares as far as its flux gives it body and the row beside it lets it: the less the arc clears that row's
    // ground, the less it widens, so the flare follows the flux smoothly.
    let amount = 0
    if (!shared && beside && want > 0) {
      const margin = Math.min(flareMargin(flank, top, foot, r, 0, lip), flareMargin(flank, top, foot, r, thick, lip))
      amount = FLARE_MAX * Math.min(1, want / BODY_MAX) * Math.min(1, Math.max(0, margin / FLARE_FADE))
    }
    arc[3] = flareCode(shared ? 0 : 1, amount)
    // The splash: where the end lands on drawn water (either row's, when shared), as wide as its speed gives it, on the
    // slope of that column's surface along the fall.
    const land = Math.min(ARC_COLUMNS - 1, Math.floor(ARC_GAP + r)), ax = x + dx * (land + 1), az = z + dz * (land + 1)
    const drawn = (px: number, pz: number) => px >= 0 && pz >= 0 && px < sx && pz < sz && shows(s[px + pz * sx]!, this.floor[px + pz * sx]!)
    const wet = drawn(ax, az) // each curtain splashes on its own landing water only; the shared data stays symmetric
    arc[4] = wet ? 1 : 0
    arc[5] = wet ? splashCode(splashHalf(speed), far[land]! - near[land]!) : 0
  }

  /**
   * The ground (blocks) a curtain must clear in column (ax, az), in the row beside its end: a column that is drawn has its
   * floor, but no higher than its drawn corners `ca`, `cb` on the end's line (the drawn surface may dip under the floor there,
   * where the arc lands); a column that is not drawn has its level.
   */
  private groundBeside(s: Int32Array, cur: boolean, ax: number, az: number, ca: number, cb: number): number {
    const a = ax + az * this.sx, w = s[a]!
    if (!shows(w, this.floor[a]!)) { this.besideNear = this.besideFar = level(w) * PER_SUB; return this.besideNear }
    const da = this.data[0]![(ax >> 5) + (az >> 5) * this.cx]
    if (da === undefined) { this.besideNear = this.besideFar = level(w) * PER_SUB; return this.floor[a]! }
    const h = cur ? da.hCur : da.hPrev, oa = ((ax & 31) + (az & 31) * 32) * 4
    this.besideNear = h[oa + ca]!
    this.besideFar = h[oa + cb]!
    return Math.min(this.floor[a]!, this.besideNear, this.besideFar)
  }

  /** Water leaving column c through its side `dir` (1/SUB block per step; negative: coming in). */
  private edgeFlux(c: number, dir: number): number {
    switch (dir) {
      case 0: return this.fluxX[c]!
      case 1: return -this.fluxX[c - 1]!
      case 2: return this.fluxZ[c]!
      default: return -this.fluxZ[c - this.sx]!
    }
  }
}

/** Heights (blocks) closer than this to their end are snapped to it in alpha mode (SurfaceView.settleRest). */
const SETTLED = 1 / 256

/** Floats a carried curtain keeps (SurfaceView.buildCurtains): its four heights, and its two ends' reaches, thicknesses and flares. */
const CARRY = 10

/**
 * Snaps the curtains within SETTLED of their end, heights, reach, thickness and flare (prev ← cur); returns whether any is
 * still farther.
 */
function settleCurtains(cs: Curtains): boolean {
  let moving = false
  for (let n = 0; n < cs.count; n++) {
    const o = n * 4
    let far = false
    for (let e = 0; e < 2; e++) {
      const fp = cs.flare[o + e]!, fc = cs.flare[o + 2 + e]!
      if (Math.abs(cs.reach[o + 2 + e]! - cs.reach[o + e]!) >= SETTLED || Math.abs(cs.thick[o + 2 + e]! - cs.thick[o + e]!) >= SETTLED) far = true
      // The drawn quantities: the widening, and the openness (stored in 1/255).
      if (Math.abs(flareAmount(fc) - flareAmount(fp)) >= SETTLED || Math.abs(flareOpen(fc) - flareOpen(fp)) > 1 / 64) far = true
    }
    for (let k = o; k < o + 4; k++) if (Math.abs(cs.cur[k]! - cs.prev[k]!) >= SETTLED) far = true
    if (far) moving = true
    else {
      for (let k = o; k < o + 4; k++) cs.prev[k] = cs.cur[k]!
      for (let e = 0; e < 2; e++) {
        cs.reach[o + e] = cs.reach[o + 2 + e]!
        cs.thick[o + e] = cs.thick[o + 2 + e]!
        cs.flare[o + e] = cs.flare[o + 2 + e]!
      }
    }
  }
  return moving
}

/** vertexShares for the vertex whose columns are halo cells a, a + 1, b, b + 1 of the effective values e. */
function shares(e: Int32Array, a: number, b: number, out: Float32Array, o: number): boolean {
  return vertexShares(e[a]!, e[a + 1]!, e[b]!, e[b + 1]!, out, o)
}

/**
 * Curtain directions (bit dir: 0 +x, 1 −x, 2 +z, 3 −z) of halo cell h of the effective values `e` (rows hw wide), as
 * curtainAt decides them. A cell outside the world has the highest level, so nothing hangs toward it.
 */
function edgeBits(e: Int32Array, h: number, hw: number): number {
  const a = e[h]!
  if (a < 0) return 0
  return (a - level(e[h + 1]!) > JOIN ? 1 : 0) | (a - level(e[h - 1]!) > JOIN ? 2 : 0)
    | (a - level(e[h + hw]!) > JOIN ? 4 : 0) | (a - level(e[h - hw]!) > JOIN ? 8 : 0)
}

/** Vertex k (0–3: (−x,−z) (+x,−z) (+x,+z) (−x,+z)) of a 3 × 3 patch: its 2 × 2 block (e0, e1, e2, e3 for vertexShares) and the centre's quadrant. */
const BLOCKS: readonly (readonly number[])[] = [[0, 1, 3, 4, 3], [1, 2, 4, 5, 2], [4, 5, 7, 8, 0], [3, 4, 6, 7, 1]]

/** Corner k of the patch's centre into out[o + k]; whether that vertex is smooth. */
function patchCorner(e: Int32Array, k: number, out: Float32Array, o: number, tmp: Float32Array): boolean {
  const b = BLOCKS[k]!
  const smooth = vertexShares(e[b[0]!]!, e[b[1]!]!, e[b[2]!]!, e[b[3]!]!, tmp, 0)
  out[o + k] = tmp[b[4]!]!
  return smooth
}

/** SurfaceView.front on a patch: a column at ec sending `out` toward cell j runs onto dry ground there, within JOIN below it. */
function frontIn(e: Int32Array, j: number, ec: number, out: number): boolean {
  const ej = e[j]!
  if (out <= 0 || ej >= 0 || ej === OUTSIDE) return false
  const drop = ec - ~ej
  return drop > 0 && drop <= JOIN
}
