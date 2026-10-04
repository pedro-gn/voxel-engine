import { TILE } from '../../sim/water/constants.ts'
import { mergeTiles, type WaterTick } from '../../sim/water/publish.ts'
import type { WorldSize } from '../../world/layout.ts'
import { SUB, type WaterBuffers } from '../../world/waterBuffers.ts'
import {
  CURTAIN_BOTTOM, CURTAIN_TOP, DIR_X, DIR_Z, FLOW_STEEP, cornerHeights, curtainAt, level, quantizeFlow, shows,
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

  mark(lz: number): void {
    if (lz < this.rowLo) this.rowLo = lz
    if (lz > this.rowHi) this.rowHi = lz
  }
}

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
  private pending: readonly number[] = []
  private readonly data: (ColumnData | undefined)[]
  private readonly dirty = new Set<number>()
  private readonly light: (x: number, y: number, z: number) => number
  private readonly stepHz: number
  private scratchS = new Int32Array(0)
  private scratchF = new Int16Array(0)
  private readonly k = new Float32Array(16)

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
  }

  column(cc: number): ColumnData | undefined { return this.data[cc] }

  /** Chunk columns whose data changed since the last call, in index order. */
  takeDirty(): number[] {
    const out = [...this.dirty].sort((a, b) => a - b)
    this.dirty.clear()
    return out
  }

  /**
   * Reads a tick's tiles (and any still pending) from shared memory. If the publish's buffer was reused before we got to it,
   * nothing is applied: the tiles wait for the next tick, whose buffer holds them complete. Returns whether it applied.
   */
  apply(t: WaterTick): boolean {
    const tiles = mergeTiles(t.tiles, this.pending)
    const p = t.parity
    if (Atomics.load(this.stamp, p) !== t.seq) { this.pending = tiles; return false }
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
    if (Atomics.load(this.stamp, p) !== t.seq) { this.pending = tiles; return false }
    this.pending = []
    k = 0
    for (const tile of tiles) {
      const first = this.seen[tile] === 0
      this.seen[tile] = 1
      const x0 = (tile % this.tx) * TILE, z0 = Math.floor(tile / this.tx) * TILE
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) {
        const c = x + z * this.sx, v = this.scratchS[k]!
        this.prev[c] = first ? v : this.cur[c]!
        this.cur[c] = v
        this.fluxX[c] = this.scratchF[2 * k]!
        this.fluxZ[c] = this.scratchF[2 * k + 1]!
        k++
      }
    }
    for (const tile of tiles) this.refreshTile(tile)
    for (const cc of this.dirty) {
      const d = this.data[cc]
      if (d) this.buildCurtains(cc, d)
    }
    return true
  }

  /** Recomputes the tile's columns and the one-column ring around it (their corners see the tile). */
  private refreshTile(tile: number): void {
    const x0 = (tile % this.tx) * TILE, z0 = Math.floor(tile / this.tx) * TILE
    const xa = Math.max(0, x0 - 1), xb = Math.min(this.sx, x0 + TILE + 1)
    const za = Math.max(0, z0 - 1), zb = Math.min(this.sz, z0 + TILE + 1)
    for (let z = za; z < zb; z++) for (let x = xa; x < xb; x++) this.refreshColumn(x, z)
  }

  private refreshColumn(x: number, z: number): void {
    const sx = this.sx, c = x + z * sx, cc = (x >> 5) + (z >> 5) * this.cx
    const fl = this.floor[c]!, pv = this.prev[c]!, cv = this.cur[c]!
    const drawn = shows(pv, fl) || shows(cv, fl)
    let d = this.data[cc]
    if (!d) {
      if (!drawn) return
      d = new ColumnData()
      this.data[cc] = d
    }
    const lz = z & 31, o = ((x & 31) + lz * 32) * 4
    d.mark(lz)
    this.dirty.add(cc)
    if (!drawn) { d.info[o + 3] = -1; return }
    cornerHeights(this.prev, this.floor, sx, this.sz, x, z, d.hPrev, o)
    cornerHeights(this.cur, this.floor, sx, this.sz, x, z, d.hCur, o)
    const s = level(cv), depth = Math.max(0, s - fl * SUB)
    const west = x > 0 ? this.fluxX[c - 1]! : 0, east = this.fluxX[c]!
    const north = z > 0 ? this.fluxZ[c - sx]! : 0, south = this.fluxZ[c]!
    // Velocity (blocks per second) = flux through a 1-block edge / depth, × steps per second.
    const h = Math.max(depth, SUB / 8)
    const speed = quantizeFlow((((west + east) / 2) / h) * this.stepHz, (((north + south) / 2) / h) * this.stepHz, d.info, o)
    let white = Math.max(0, Math.min(15, Math.round((speed - FLOW_STEEP) * 4)))
    if (x > 0) white = Math.max(white, this.foot(c - 1, c, west))
    if (x + 1 < sx) white = Math.max(white, this.foot(c + 1, c, -east))
    if (z > 0) white = Math.max(white, this.foot(c - sx, c, north))
    if (z + 1 < this.sz) white = Math.max(white, this.foot(c + sx, c, -south))
    const l = this.light(x, Math.ceil(s / SUB), z)
    d.info[o + 2] = depth / SUB
    d.info[o + 3] = (l & 15) * 16 + (l >> 4) + 256 * white
  }

  /** White water (0–15) at the foot of a curtain from column j into c carrying `into` (1/SUB block per step toward c). */
  private foot(j: number, c: number, into: number): number {
    if (into <= 0 || !curtainAt(this.cur, this.floor, j, c)) return 0
    return Math.min(15, into >> 4)
  }

  private buildCurtains(cc: number, d: ColumnData): void {
    const cs = d.curtains, sx = this.sx, sz = this.sz, k = this.k
    const x0 = (cc % this.cx) * 32, z0 = Math.floor(cc / this.cx) * 32
    let n = 0
    for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
      const packed = d.info[(lx + lz * 32) * 4 + 3]!
      if (packed < 0) continue // not drawn in either step: nothing hangs from it
      const x = x0 + lx, z = z0 + lz, c = x + z * sx
      for (let dir = 0; dir < 4; dir++) {
        const jx = x + DIR_X[dir]!, jz = z + DIR_Z[dir]!
        if (jx < 0 || jz < 0 || jx >= sx || jz >= sz) continue
        const j = jx + jz * sx
        const was = curtainAt(this.prev, this.floor, c, j), now = curtainAt(this.cur, this.floor, c, j)
        if (!was && !now) continue
        cornerHeights(this.prev, this.floor, sx, sz, x, z, k, 0)
        cornerHeights(this.cur, this.floor, sx, sz, x, z, k, 4)
        const jp = cornerHeights(this.prev, this.floor, sx, sz, jx, jz, k, 8)
        const jc = cornerHeights(this.cur, this.floor, sx, sz, jx, jz, k, 12)
        const [ta, tb] = CURTAIN_TOP[dir]!, [ba, bb] = CURTAIN_BOTTOM[dir]!
        const gp = level(this.prev[j]!) / SUB, gc = level(this.cur[j]!) / SUB
        cs.reserve(n + 1)
        const o = n * 4
        edge(cs.prev, o, was, k[ta]!, k[tb]!, jp ? k[8 + ba]! : gp, jp ? k[8 + bb]! : gp)
        edge(cs.cur, o, now, k[4 + ta]!, k[4 + tb]!, jc ? k[12 + ba]! : gc, jc ? k[12 + bb]! : gc)
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

/** A curtain's (top A, top B, bottom A, bottom B); one absent in this step is rolled up to its top. */
function edge(out: Float32Array, o: number, on: boolean, ta: number, tb: number, ba: number, bb: number): void {
  out[o] = ta
  out[o + 1] = tb
  out[o + 2] = on ? ba : ta
  out[o + 3] = on ? bb : tb
}
