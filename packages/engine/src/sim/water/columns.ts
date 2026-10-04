import { DEPTH_EPS, FLUX_EPS, FLUX_FP, FRICTION_SHIFT, GAIN, MAX_HEAD, MIN_FLOW, SLEEP_STEPS, SUB, TILE } from './constants.ts'
import { WaterTiles } from './tiles.ts'

const FRICTION_MASK = (1 << FRICTION_SHIFT) - 1

/** A stored flux after one step of friction: loses 1/2^FRICTION_SHIFT, rounded away from zero, so a lone flux always dies out. */
export function damp(f: number): number {
  if (f > 0) return f - ((f + FRICTION_MASK) >> FRICTION_SHIFT)
  if (f < 0) return f + ((FRICTION_MASK - f) >> FRICTION_SHIFT)
  return 0
}

/** Water (1/SUB block) an edge with stored flux f moves this step: truncated toward zero, the same both ways. */
export function moved(f: number): number {
  return f >= 0 ? f >> FLUX_FP : -((-f) >> FLUX_FP) | 0
}

/** An outflow f > 0 (stored units) scaled so a column sending `out` in all moves only its depth `d`: whole 1/SUB, rounded down. */
function scaled(f: number, d: number, out: number): number {
  return Math.floor(((f >> FLUX_FP) * d) / out) << FLUX_FP
}

/** A growable Int32 list, reused every step. */
class IntList {
  data = new Int32Array(1024)
  length = 0
  push(v: number): void {
    if (this.length === this.data.length) {
      const d = new Int32Array(this.data.length * 2)
      d.set(this.data)
      this.data = d
    }
    this.data[this.length++] = v
  }
  clear(): void { this.length = 0 }
}

/**
 * The heightfield (spec §3; plan design notes: Columns, The step). Pure: no voxels. Every field is an integer and every
 * loop has a fixed order, so two stores fed the same edits stay identical.
 */
export class WaterColumns {
  readonly sx: number
  readonly sz: number
  readonly n: number
  /** Per column (x + z × sx): y of the top face the water rests on. A view of the shared floor buffer. */
  readonly floor: Int16Array
  /** Per column: water in 1/SUB block. */
  readonly depth: Int32Array
  /** Per column c: flux through its +x edge at 2c and its +z edge at 2c + 1 (1/(16 SUB) block per step; positive toward +x / +z). */
  readonly flux: Int32Array
  readonly tiles: WaterTiles
  /** Per column: depth after its last step (the quiet test). */
  private readonly last: Int32Array
  private readonly stepping: Uint8Array
  private readonly list = new IntList()
  private readonly edges = new IntList()
  private readonly edgeEnd = new IntList()
  private readonly ring = new IntList()
  private most = new Int32Array(64)
  private cursor = 0

  constructor(sx: number, sz: number, floor: Int16Array) {
    if (floor.length !== sx * sz) throw new RangeError(`floor has ${floor.length} columns, expected ${sx * sz}`)
    this.sx = sx
    this.sz = sz
    this.n = sx * sz
    this.floor = floor
    this.depth = new Int32Array(this.n)
    this.flux = new Int32Array(this.n * 2)
    this.last = new Int32Array(this.n)
    this.tiles = new WaterTiles(sx, sz)
    this.stepping = new Uint8Array(this.tiles.count)
  }

  surface(c: number): number { return this.floor[c]! * SUB + this.depth[c]! }

  /** Σ depth. */
  total(): number {
    let s = 0
    for (let c = 0; c < this.n; c++) s += this.depth[c]!
    return s
  }

  /** Wet columns in awake tiles (EngineStats.waterColumns). */
  wetAwake(): number {
    const T = this.tiles
    let n = 0
    for (let t = 0; t < T.count; t++) {
      if (T.awake[t] === 1) T.forEachColumn(t, (c) => { if (this.depth[c]! > 0) n++ })
    }
    return n
  }

  /**
   * One step over at most `cap` awake tiles (round robin): accelerate every edge touching them, limit each column's
   * outflow to its depth, move the water, pin the sea columns (`sea` mask, at `seaSurface`), and put quiet tiles to sleep.
   * Returns what the sea columns gave the sea account (negative: what they took from it).
   */
  step(cap: number, sea: Uint8Array | null, seaSurface: number): number {
    this.collect(cap)
    this.accelerate()
    this.limit()
    this.transfer()
    const credit = sea ? this.pin(sea, seaSurface) : 0
    this.settle()
    for (let k = 0; k < this.list.length; k++) this.stepping[this.list.data[k]!] = 0
    return credit
  }

  mixState(mix: (v: number) => void): void {
    mix(this.cursor)
    for (let c = 0; c < this.n; c++) {
      mix(this.floor[c]!); mix(this.depth[c]!); mix(this.last[c]!)
      mix(this.flux[2 * c]!); mix(this.flux[2 * c + 1]!)
    }
    this.tiles.mixState(mix)
  }

  /** The stepped tiles, their edges (each touching edge once) and the ring of outside columns those edges reach. */
  private collect(cap: number): void {
    const T = this.tiles
    this.list.clear(); this.edges.clear(); this.edgeEnd.clear(); this.ring.clear()
    let t = this.cursor
    for (let k = 0; k < T.count && this.list.length < cap; k++) {
      if (T.awake[t] === 1) { this.list.push(t); this.stepping[t] = 1 }
      t = t + 1 === T.count ? 0 : t + 1
    }
    this.cursor = t
    if (this.most.length < this.list.length) this.most = new Int32Array(this.list.length * 2)
    for (let k = 0; k < this.list.length; k++) {
      this.tileEdges(this.list.data[k]!)
      this.edgeEnd.push(this.edges.length)
    }
  }

  private tileEdges(t: number): void {
    const T = this.tiles, sx = this.sx, sz = this.sz
    const x0 = (t % T.tx) * TILE, z0 = Math.floor(t / T.tx) * TILE, x1 = x0 + TILE, z1 = z0 + TILE
    T.forEachColumn(t, (c, x, z) => {
      if (x + 1 < sx) this.edges.push(c * 2)
      if (z + 1 < sz) this.edges.push(c * 2 + 1)
    })
    // Edges owned by a neighbour tile that does not step are this tile's to move; their outside columns are limited as a ring.
    if (x0 > 0 && this.stepping[t - 1] === 0) for (let z = z0; z < z1; z++) { const c = x0 - 1 + z * sx; this.edges.push(c * 2); this.ring.push(c) }
    if (z0 > 0 && this.stepping[t - T.tx] === 0) for (let x = x0; x < x1; x++) { const c = x + (z0 - 1) * sx; this.edges.push(c * 2 + 1); this.ring.push(c) }
    if (x1 < sx && this.stepping[t + 1] === 0) for (let z = z0; z < z1; z++) this.ring.push(x1 + z * sx)
    if (z1 < sz && this.stepping[t + T.tx] === 0) for (let x = x0; x < x1; x++) this.ring.push(x + z1 * sx)
  }

  private accelerate(): void {
    const floor = this.floor, depth = this.depth, flux = this.flux, sx = this.sx, E = this.edges.data
    for (let k = 0; k < this.edges.length; k++) {
      const e = E[k]!, a = e >> 1, b = a + ((e & 1) === 0 ? 1 : sx)
      const fa = floor[a]! * SUB, fb = floor[b]! * SUB, da = depth[a]!, db = depth[b]!
      const sa = fa + da, sb = fb + db
      let h = sa - sb
      if (h > MAX_HEAD) h = MAX_HEAD
      else if (h < -MAX_HEAD) h = -MAX_HEAD
      let f = damp(flux[e]!) + h * GAIN
      // Thin films send nothing, and water never moves into a column whose floor is at or above the sender's surface.
      if (f > 0) { if (da < MIN_FLOW || sa <= fb) f = 0 }
      else if (f < 0) { if (db < MIN_FLOW || sb <= fa) f = 0 }
      flux[e] = f
    }
  }

  /** Every column of the stepped tiles (in visit order, row-major), then every ring column. */
  private forEachTouched(fn: (c: number, x: number, z: number) => void): void {
    const sx = this.sx
    for (let k = 0; k < this.list.length; k++) this.tiles.forEachColumn(this.list.data[k]!, fn)
    for (let k = 0; k < this.ring.length; k++) {
      const c = this.ring.data[k]!, x = c % sx
      fn(c, x, (c - x) / sx)
    }
  }

  private limit(): void {
    this.forEachTouched((c, x, z) => this.limitColumn(c, x, z))
  }

  /** Scales every outflow of column c so that together they move at most its depth. */
  private limitColumn(c: number, x: number, z: number): void {
    const flux = this.flux, sx = this.sx
    const east = x + 1 < sx ? c * 2 : -1, south = z + 1 < this.sz ? c * 2 + 1 : -1
    const west = x > 0 ? (c - 1) * 2 : -1, north = z > 0 ? (c - sx) * 2 + 1 : -1
    let out = 0
    if (east >= 0 && flux[east]! > 0) out += flux[east]! >> FLUX_FP
    if (south >= 0 && flux[south]! > 0) out += flux[south]! >> FLUX_FP
    if (west >= 0 && flux[west]! < 0) out += -flux[west]! >> FLUX_FP
    if (north >= 0 && flux[north]! < 0) out += -flux[north]! >> FLUX_FP
    const d = this.depth[c]!
    if (out <= d) return
    if (east >= 0 && flux[east]! > 0) flux[east] = scaled(flux[east]!, d, out)
    if (south >= 0 && flux[south]! > 0) flux[south] = scaled(flux[south]!, d, out)
    if (west >= 0 && flux[west]! < 0) flux[west] = -scaled(-flux[west]!, d, out)
    if (north >= 0 && flux[north]! < 0) flux[north] = -scaled(-flux[north]!, d, out)
  }

  private transfer(): void {
    const depth = this.depth, flux = this.flux, sx = this.sx, E = this.edges.data
    let e = 0
    for (let k = 0; k < this.list.length; k++) {
      const end = this.edgeEnd.data[k]!
      let most = 0
      for (; e < end; e++) {
        const edge = E[e]!, a = edge >> 1, b = a + ((edge & 1) === 0 ? 1 : sx)
        const m = moved(flux[edge]!)
        if (m === 0) continue
        depth[a] = depth[a]! - m
        depth[b] = depth[b]! + m
        const am = m < 0 ? -m : m
        if (am > most) most = am
        this.reach(a, am)
        this.reach(b, am)
      }
      this.most[k] = most
    }
  }

  /** Water moved in or out of column c: if its tile does not step, mirror and publish it, and a real stream wakes it. */
  private reach(c: number, amount: number): void {
    const T = this.tiles, x = c % this.sx
    const t = T.of(x, (c - x) / this.sx)
    if (this.stepping[t] === 1) return
    T.dirty[t] = 1
    if (amount >= FLUX_EPS) T.wake(t)
  }

  private pin(sea: Uint8Array, target: number): number {
    let credit = 0
    this.forEachTouched((c) => { credit += this.pinColumn(c, sea, target) })
    return credit
  }

  /** Sets a sea column back to the sea's surface; returns the water it gave (negative: took). */
  private pinColumn(c: number, sea: Uint8Array, target: number): number {
    if (sea[c] !== 1) return 0
    const d = this.floor[c]! * SUB + this.depth[c]! - target
    if (d === 0 || this.depth[c]! - d < 0) return 0
    this.depth[c] = this.depth[c]! - d
    return d
  }

  private settle(): void {
    const T = this.tiles
    let start = 0
    for (let k = 0; k < this.list.length; k++) {
      const t = this.list.data[k]!, end = this.edgeEnd.data[k]!
      let change = 0
      T.forEachColumn(t, (c) => {
        const d = this.depth[c]! - this.last[c]!
        this.last[c] = this.depth[c]!
        if (d > change) change = d
        else if (-d > change) change = -d
      })
      T.dirty[t] = 1
      if (this.most[k]! < FLUX_EPS && change <= DEPTH_EPS) {
        T.quiet[t] = T.quiet[t]! + 1
        if (T.quiet[t]! >= SLEEP_STEPS) {
          T.awake[t] = 0
          T.quiet[t] = 0
          for (let e = start; e < end; e++) this.flux[this.edges.data[e]!] = 0
        }
      } else {
        T.quiet[t] = 0
      }
      start = end
    }
  }
}
