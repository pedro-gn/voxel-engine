import { TILE } from '../../sim/water/constants.ts'
import { mergeTiles, type WaterTick } from '../../sim/water/publish.ts'
import type { WorldSize } from '../../world/layout.ts'
import { SUB, type WaterBuffers } from '../../world/waterBuffers.ts'
import {
  CURTAIN_BOTTOM, CURTAIN_TOP, DIR_X, DIR_Z, FLOW_STEEP, JOIN, OUTSIDE, SINK, effective, level, quantizeFlow, shows, vertexShares,
} from './surfaceMesh.ts'

/**
 * The curtains of one chunk column, per curtain (4 floats each):
 * - `prev`, `cur`: (top A, top B, bottom A, bottom B) heights in blocks;
 * - `info`: (lx, lz, dir + 4 × light, flux).
 */
export class Curtains {
  count = 0
  prev = new Float32Array(64)
  cur = new Float32Array(64)
  info = new Float32Array(64)
  /** Bumped whenever the arrays are replaced: the renderer then rebuilds its attributes. */
  generation = 0

  reserve(n: number): void {
    if (n * 4 <= this.prev.length) return
    let cap = this.prev.length
    while (cap < n * 4) cap *= 2
    const grow = (a: Float32Array): Float32Array<ArrayBuffer> => { const b = new Float32Array(cap); b.set(a); return b }
    this.prev = grow(this.prev)
    this.cur = grow(this.cur)
    this.info = grow(this.info)
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
  /** Chunk columns along x and z. */
  readonly cx: number
  readonly cz: number
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
  private readonly data: (ColumnData | undefined)[]
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
  /** Chunk columns whose curtains are rebuilt at the end of this apply. */
  private readonly touchedFlag: Uint8Array
  private readonly touched: number[] = []
  /** Chunk columns changed since the renderer last took them; `spare` is the list handed out by the last takeDirty. */
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
  /** Per curtain key (column × 4 + dir) of the chunk column being rebuilt: its heights as drawn, if it had one (tag = token). */
  private readonly carryTag = new Int32Array(4096)
  private readonly carryVal = new Float32Array(4096 * 4)
  private carryToken = 0

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
    this.data = new Array<ColumnData | undefined>(this.cx * this.cz)
    this.light = light
    this.stepHz = stepHz
    this.changed = new Uint16Array(this.n)
    this.refreshed = new Uint16Array(this.n)
    this.tileChanged = new Uint16Array(this.seen.length)
    this.tileListed = new Uint16Array(this.seen.length)
    this.tileFresh = new Uint16Array(this.seen.length)
    this.tileSettled = new Uint8Array(this.seen.length).fill(1)
    this.touchedFlag = new Uint8Array(this.cx * this.cz)
    this.dirtyFlag = new Uint8Array(this.cx * this.cz)
  }

  column(cc: number): ColumnData | undefined { return this.data[cc] }

  /**
   * Chunk columns whose data changed since the last call, in index order. The array is reused: it stays valid until the next
   * call, and the caller must not keep or modify it.
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
      if (any) this.tileChanged[tile] = e
      this.tileListed[tile] = e
      if (first) this.tileFresh[tile] = e
      this.tileSettled[tile] = moving ? 0 : 1
    }
    this.lastCc = -1
    this.shown = shown ?? -1
    for (const tile of tiles) if (this.tileChanged[tile] === e) this.refreshTile(tile, e)
    for (const cc of this.touched) {
      this.touchedFlag[cc] = 0
      const d = this.data[cc]
      if (d) { this.buildCurtains(cc, d, this.shown); this.markDirty(cc) }
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
    const d = this.data[cc]
    if (!d) return
    const x0 = (cc % this.cx) * 32, z0 = Math.floor(cc / this.cx) * 32, info = d.info
    let any = false, curtains = false
    for (let i = 0; i < 1024; i++) {
      const o = i * 4 + 3, packed = info[o]!
      if (packed < 0) continue
      const x = x0 + (i & 31), z = z0 + (i >> 5), y = Math.ceil(level(this.cur[x + z * this.sx]!) * PER_SUB)
      if (y < y0 || y >= y1) continue
      const l = this.light(x, y, z), lit = packed - (packed % 256) + (l & 15) * 16 + (l >> 4)
      if (lit === packed) continue
      info[o] = lit
      d.mark(i >> 5)
      any = true
      if (d.curtainMask[i] !== 0) curtains = true
    }
    if (curtains) this.buildCurtains(cc, d, 0) // the heights do not change: every curtain keeps them
    if (any) this.markDirty(cc)
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
      this.epoch = 1
    }
    return this.epoch
  }

  private markDirty(cc: number): void {
    if (this.dirtyFlag[cc] === 0) { this.dirtyFlag[cc] = 1; this.dirty.push(cc) }
  }

  private touch(cc: number): void {
    if (this.touchedFlag[cc] === 0) { this.touchedFlag[cc] = 1; this.touched.push(cc) }
  }

  /**
   * Refreshes the columns of the tile and its one-column ring (their corners see the tile) that this apply's changes reach:
   * those with a changed column among their 3 × 3. A ring side is left to the tile beyond it when that tile changed too, and
   * each column is refreshed at most once per apply. Every vertex of the region is grouped once per step, or only for the
   * current step when the region is aligned (see `aligned`).
   */
  private refreshTile(tile: number, e: number): void {
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

  /**
   * Column (x, z): `h` its halo cell (rows hw wide), `vi` its (−x,−z) vertex (rows vw wide) in the region being refreshed;
   * `aligned`: its previous step is the last apply's current step (see `aligned`).
   */
  private refreshColumn(x: number, z: number, h: number, hw: number, vi: number, vw: number, aligned: boolean): void {
    const sx = this.sx, c = x + z * sx, cc = (x >> 5) + (z >> 5) * this.cx
    const fl = this.floor[c]!, pv = this.prev[c]!, ec = this.eC[h]!
    const was = shows(pv, fl), drawn = was || ec >= 0
    let d = this.data[cc]
    if (!d) {
      if (!drawn) return
      d = new ColumnData()
      this.data[cc] = d
    }
    const lx = x & 31, lz = z & 31, i = lx + lz * 32, o = i * 4
    d.mark(lz)
    // A curtain depends only on its column's 3 × 3 (its bottom corners' vertices included), so refreshing the column's own
    // chunk column's curtains is enough.
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
    const speed = quantizeFlow((west + east) * k, (north + south) * k, d.info, o)
    let white = speed > FLOW_STEEP ? Math.min(15, Math.round((speed - FLOW_STEEP) * 4)) : 0
    let curBits = 0
    if ((sm[vi]! & sm[vi + 1]! & sm[vi + vw]! & sm[vi + vw + 1]! & 2) === 0) {
      curBits = edgeBits(this.eC, h, hw)
      // White water at the foot of a curtain falling into c, from the water it carries toward c.
      white = Math.max(white, this.foot(h - 1, ec, west), this.foot(h + 1, ec, -east), this.foot(h - hw, ec, north), this.foot(h + hw, ec, -south))
    }
    const l = this.light(x, Math.ceil(s * PER_SUB), z)
    d.info[o + 2] = depth * PER_SUB
    d.info[o + 3] = (l & 15) * 16 + (l >> 4) + 256 * white
    d.curtainMask[i] = prevBits | (curBits << 4)
  }

  /** White water (0–15) at the foot of a curtain from halo cell j onto a column at effective value ec, carrying `into`. */
  private foot(j: number, ec: number, into: number): number {
    const ej = this.eC[j]!
    if (into <= 0 || ej < 0 || ej - level(ec) <= JOIN) return 0
    return Math.min(15, into >> 4)
  }

  /**
   * Lists a chunk column's curtains from its curtain masks and the corners refreshed this apply. `carry` ≥ 0: a curtain the
   * list already had starts from its heights drawn at alpha `carry` (see apply); negative: from its previous step.
   */
  private buildCurtains(cc: number, d: ColumnData, carry: number): void {
    const cs = d.curtains, sx = this.sx, mask = d.curtainMask
    const tag = this.carryTag, val = this.carryVal, token = carry >= 0 ? ++this.carryToken : 0
    if (carry >= 0) {
      for (let k = 0; k < cs.count; k++) {
        const o = k * 4, key = (cs.info[o]! + cs.info[o + 1]! * 32) * 4 + (cs.info[o + 2]! % 4), v = key * 4
        tag[key] = token
        for (let j = 0; j < 4; j++) val[v + j] = cs.prev[o + j]! + (cs.cur[o + j]! - cs.prev[o + j]!) * carry
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
        const jx = x + DIR_X[dir]!, jz = z + DIR_Z[dir]!, j = jx + jz * sx
        const dj = this.data[(jx >> 5) + (jz >> 5) * this.cx], oj = ((jx & 31) + (jz & 31) * 32) * 4
        const fj = this.floor[j]!, pj = this.prev[j]!, cj = this.cur[j]!
        const [ta, tb] = CURTAIN_TOP[dir]!, [ba, bb] = CURTAIN_BOTTOM[dir]!
        const gp = level(pj) / SUB, gc = level(cj) / SUB
        // A neighbour drawn in a step has its corners there; otherwise the curtain reaches its ground.
        const jp = dj !== undefined && shows(pj, fj) ? dj : undefined
        const jc = dj !== undefined && shows(cj, fj) ? dj : undefined
        cs.reserve(n + 1)
        const o = n * 4
        edge(cs.prev, o, was, d.hPrev[o4 + ta]!, d.hPrev[o4 + tb]!, jp ? jp.hPrev[oj + ba]! : gp, jp ? jp.hPrev[oj + bb]! : gp)
        edge(cs.cur, o, now, d.hCur[o4 + ta]!, d.hCur[o4 + tb]!, jc ? jc.hCur[oj + ba]! : gc, jc ? jc.hCur[oj + bb]! : gc)
        const key = i * 4 + dir
        if (token !== 0 && tag[key] === token) for (let j = 0; j < 4; j++) cs.prev[o + j] = val[key * 4 + j]!
        cs.info[o] = lx
        cs.info[o + 1] = lz
        cs.info[o + 2] = dir + 4 * (packed % 256)
        cs.info[o + 3] = Math.max(0, this.edgeFlux(c, dir))
        n++
      }
    }
    cs.count = n
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

/** A curtain's (top A, top B, bottom A, bottom B); one absent in this step is rolled up to its top. */
function edge(out: Float32Array, o: number, on: boolean, ta: number, tb: number, ba: number, bb: number): void {
  out[o] = ta
  out[o + 1] = tb
  out[o + 2] = on ? ba : ta
  out[o + 3] = on ? bb : tb
}
