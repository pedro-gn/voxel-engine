import * as K from './constants.ts'
import { WaterTiles } from './tiles.ts'

// Plain module constants: Vitest's module transform turns imported bindings into property reads, several times slower in
// the step's loops.
const { DEPTH_EPS, FLUX_EPS, FLUX_FP, FRICTION_SHIFT, GAIN, HEAD_EPS, MAX_HEAD, MIN_FLOW, SLEEP_STEPS, SLOPE_SHIFT, SUB, TILE } = K

const FRICTION_MASK = (1 << FRICTION_SHIFT) - 1
/** A stored flux this large (either sign) moves FLUX_EPS or more: the edge is not quiet. */
const LOUD = FLUX_EPS << FLUX_FP

/** Sides of a stepped tile whose neighbour tile exists and does not step: their border edges and columns are the tile's. */
const WEST = 1, NORTH = 2, EAST = 4, SOUTH = 8

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

/** Step 2 for edge e (a → b): friction, the head, then no flux from a thin film or toward a floor at the sender's surface. */
function accelerate(floor: Int16Array, depth: Int32Array, flux: Int32Array, e: number, a: number, b: number): void {
  const fa = floor[a]! * SUB, fb = floor[b]! * SUB, da = depth[a]!, db = depth[b]!
  const sa = fa + da, sb = fb + db
  let h = sa - sb
  if (h > MAX_HEAD) h = MAX_HEAD
  else if (h < -MAX_HEAD) h = -MAX_HEAD
  let f = damp(flux[e]!) + h * GAIN
  if (f > 0) { if (da < MIN_FLOW || sa <= fb) f = 0 }
  else if (f < 0) { if (db < MIN_FLOW || sb <= fa) f = 0 }
  flux[e] = f
}

/** Step 3 for column c: scales its outflows (east, south, west, north edges; −1 where none) to move at most its depth. */
function limit(depth: Int32Array, flux: Int32Array, c: number, east: number, south: number, west: number, north: number): void {
  let out = 0
  if (east >= 0 && flux[east]! > 0) out += flux[east]! >> FLUX_FP
  if (south >= 0 && flux[south]! > 0) out += flux[south]! >> FLUX_FP
  if (west >= 0 && flux[west]! < 0) out += -flux[west]! >> FLUX_FP
  if (north >= 0 && flux[north]! < 0) out += -flux[north]! >> FLUX_FP
  const d = depth[c]!
  if (out <= d) return
  if (east >= 0 && flux[east]! > 0) flux[east] = scaled(flux[east]!, d, out)
  if (south >= 0 && flux[south]! > 0) flux[south] = scaled(flux[south]!, d, out)
  if (west >= 0 && flux[west]! < 0) flux[west] = -scaled(-flux[west]!, d, out)
  if (north >= 0 && flux[north]! < 0) flux[north] = -scaled(-flux[north]!, d, out)
}

/** Step 4 for edge e (a → b): moves its water; returns the amount (≥ 0). */
function transfer(depth: Int32Array, flux: Int32Array, e: number, a: number, b: number): number {
  const m = moved(flux[e]!)
  if (m === 0) return 0
  depth[a] = depth[a]! - m
  depth[b] = depth[b]! + m
  return m < 0 ? -m : m
}

/** Step 5 for column c: a sea column goes back to the sea's surface; returns the water it gave (negative: took). */
function pin(floor: Int16Array, depth: Int32Array, sea: Uint8Array, target: number, c: number): number {
  if (sea[c] !== 1) return 0
  const d = floor[c]! * SUB + depth[c]! - target
  if (d === 0 || depth[c]! - d < 0) return 0
  depth[c] = depth[c]! - d
  return d
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
 * loop has a fixed order, so two stores fed the same edits stay identical. Each phase walks the stepped tiles' columns
 * directly, row-major: a tile's own +x and +z edges, plus its −x (−z) border edges when the neighbour there does not step.
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
  /** The stepped tiles, in visit order. */
  private readonly list = new IntList()
  /** Per stepped tile (list index): its WEST | NORTH | EAST | SOUTH sides that face a tile that does not step. */
  private open = new Uint8Array(64)
  /** Per stepped tile (list index): the most water one of its edges moved this step. */
  private most = new Int32Array(64)
  /** Columns outside the stepped tiles that their edges reach. */
  private readonly ring = new IntList()
  private readonly asleep = new IntList()
  /** runLive's sums over a tile's runs along one axis: Σ (last − first surface), and Σ edges. */
  private fall = 0
  private span = 0
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
    const T = this.tiles, sx = this.sx, depth = this.depth
    let n = 0
    for (let t = 0; t < T.count; t++) {
      if (T.awake[t] !== 1) continue
      const x0 = (t % T.tx) * TILE, z0 = Math.floor(t / T.tx) * TILE
      for (let z = z0; z < z0 + TILE; z++) for (let c = x0 + z * sx, e = c + TILE; c < e; c++) if (depth[c]! > 0) n++
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
    this.accelerateAll()
    this.limitAll()
    this.transferAll()
    const credit = sea ? this.pinAll(sea, seaSurface) : 0
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

  /** The stepped tiles, the sides where their neighbour does not step, and the ring of outside columns their edges reach. */
  private collect(cap: number): void {
    const T = this.tiles, sx = this.sx, tx = T.tx, tz = T.tz, stepping = this.stepping
    this.list.clear(); this.ring.clear()
    let t = this.cursor
    for (let k = 0; k < T.count && this.list.length < cap; k++) {
      if (T.awake[t] === 1) { this.list.push(t); stepping[t] = 1 }
      t = t + 1 === T.count ? 0 : t + 1
    }
    this.cursor = t
    const n = this.list.length
    if (this.open.length < n) { this.open = new Uint8Array(n * 2); this.most = new Int32Array(n * 2) }
    for (let k = 0; k < n; k++) {
      const t = this.list.data[k]!, tX = t % tx, tZ = (t - tX) / tx
      const x0 = tX * TILE, z0 = tZ * TILE, x1 = x0 + TILE, z1 = z0 + TILE
      let o = 0
      if (tX > 0 && stepping[t - 1] === 0) { o |= WEST; for (let z = z0; z < z1; z++) this.ring.push(x0 - 1 + z * sx) }
      if (tZ > 0 && stepping[t - tx] === 0) { o |= NORTH; for (let x = x0; x < x1; x++) this.ring.push(x + (z0 - 1) * sx) }
      if (tX + 1 < tx && stepping[t + 1] === 0) { o |= EAST; for (let z = z0; z < z1; z++) this.ring.push(x1 + z * sx) }
      if (tZ + 1 < tz && stepping[t + tx] === 0) { o |= SOUTH; for (let x = x0; x < x1; x++) this.ring.push(x + z1 * sx) }
      this.open[k] = o
    }
  }

  private accelerateAll(): void {
    const floor = this.floor, depth = this.depth, flux = this.flux, sx = this.sx, sz = this.sz, tx = this.tiles.tx
    for (let k = 0; k < this.list.length; k++) {
      const t = this.list.data[k]!, o = this.open[k]!
      const x0 = (t % tx) * TILE, z0 = Math.floor(t / tx) * TILE, x1 = x0 + TILE, z1 = z0 + TILE
      const xe = x1 < sx ? x1 : x1 - 1, ze = z1 < sz ? z1 : z1 - 1 // edges leave columns x < xe (+x), rows z < ze (+z)
      for (let z = z0; z < z1; z++) {
        const row = z * sx
        for (let x = x0; x < xe; x++) { const c = x + row; accelerate(floor, depth, flux, c * 2, c, c + 1) }
        if (z < ze) for (let x = x0; x < x1; x++) { const c = x + row; accelerate(floor, depth, flux, c * 2 + 1, c, c + sx) }
      }
      if ((o & WEST) !== 0) for (let z = z0; z < z1; z++) { const c = x0 - 1 + z * sx; accelerate(floor, depth, flux, c * 2, c, c + 1) }
      if ((o & NORTH) !== 0) for (let x = x0; x < x1; x++) { const c = x + (z0 - 1) * sx; accelerate(floor, depth, flux, c * 2 + 1, c, c + sx) }
    }
  }

  /** Every column of the stepped tiles, then every ring column: each one's outflows together move at most its depth. */
  private limitAll(): void {
    const depth = this.depth, flux = this.flux, sx = this.sx, sz = this.sz, tx = this.tiles.tx
    for (let k = 0; k < this.list.length; k++) {
      const t = this.list.data[k]!
      const x0 = (t % tx) * TILE, z0 = Math.floor(t / tx) * TILE
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0, c = x0 + z * sx; x < x0 + TILE; x++, c++) {
        limit(depth, flux, c, x + 1 < sx ? c * 2 : -1, z + 1 < sz ? c * 2 + 1 : -1, x > 0 ? (c - 1) * 2 : -1, z > 0 ? (c - sx) * 2 + 1 : -1)
      }
    }
    for (let k = 0; k < this.ring.length; k++) {
      const c = this.ring.data[k]!, x = c % sx, z = (c - x) / sx
      limit(depth, flux, c, x + 1 < sx ? c * 2 : -1, z + 1 < sz ? c * 2 + 1 : -1, x > 0 ? (c - 1) * 2 : -1, z > 0 ? (c - sx) * 2 + 1 : -1)
    }
  }

  /** Moves the water of every edge touching a stepped tile. Water crossing into a tile that does not step reaches it. */
  private transferAll(): void {
    const depth = this.depth, flux = this.flux, sx = this.sx, sz = this.sz, tx = this.tiles.tx
    for (let k = 0; k < this.list.length; k++) {
      const t = this.list.data[k]!, o = this.open[k]!
      const x0 = (t % tx) * TILE, z0 = Math.floor(t / tx) * TILE, x1 = x0 + TILE, z1 = z0 + TILE
      const xe = x1 < sx ? x1 : x1 - 1, ze = z1 < sz ? z1 : z1 - 1
      let most = 0
      for (let z = z0; z < z1; z++) {
        const row = z * sx
        for (let x = x0; x < xe; x++) {
          const c = x + row, m = transfer(depth, flux, c * 2, c, c + 1)
          if (m > most) most = m
          if (m > 0 && x + 1 === x1 && (o & EAST) !== 0) this.reach(t + 1, m)
        }
        if (z < ze) for (let x = x0; x < x1; x++) {
          const c = x + row, m = transfer(depth, flux, c * 2 + 1, c, c + sx)
          if (m > most) most = m
          if (m > 0 && z + 1 === z1 && (o & SOUTH) !== 0) this.reach(t + tx, m)
        }
      }
      if ((o & WEST) !== 0) for (let z = z0; z < z1; z++) {
        const c = x0 - 1 + z * sx, m = transfer(depth, flux, c * 2, c, c + 1)
        if (m > most) most = m
        if (m > 0) this.reach(t - 1, m)
      }
      if ((o & NORTH) !== 0) for (let x = x0; x < x1; x++) {
        const c = x + (z0 - 1) * sx, m = transfer(depth, flux, c * 2 + 1, c, c + sx)
        if (m > most) most = m
        if (m > 0) this.reach(t - tx, m)
      }
      this.most[k] = most
    }
  }

  /** `amount` of water crossed into tile t, which does not step: mirror and publish it, and a real stream wakes it. */
  private reach(t: number, amount: number): void {
    const T = this.tiles
    T.dirty[t] = 1
    if (amount >= FLUX_EPS) T.wake(t)
  }

  private pinAll(sea: Uint8Array, target: number): number {
    const floor = this.floor, depth = this.depth, sx = this.sx, tx = this.tiles.tx
    let credit = 0
    for (let k = 0; k < this.list.length; k++) {
      const t = this.list.data[k]!
      const x0 = (t % tx) * TILE, z0 = Math.floor(t / tx) * TILE
      for (let z = z0; z < z0 + TILE; z++) for (let c = x0 + z * sx, e = c + TILE; c < e; c++) credit += pin(floor, depth, sea, target, c)
    }
    for (let k = 0; k < this.ring.length; k++) credit += pin(floor, depth, sea, target, this.ring.data[k]!)
    return credit
  }

  /**
   * The quiet test, the same on every side of a tile. A stepped tile is quiet when no column changed by more than
   * DEPTH_EPS since its last step, no edge touching it (its four borders included) moved FLUX_EPS or more, and no run of
   * connected water along a row or a column of the tile, extended one column past each border, spans more than HEAD_EPS,
   * and the runs' mean slope along x and along z is at most 1/2^SLOPE_SHIFT per column (runLive). These see the head, not
   * just the water moved, so a gentle slope cannot freeze, and they read every edge of the tile alike, so a world and its
   * mirror image sleep alike. After SLEEP_STEPS quiet steps it sleeps, and its fluxes are zeroed, except a border edge whose other tile is still awake
   * after the step: that tile goes on moving it. Then a ring column (outside, not stepping) that now stands more than
   * HEAD_EPS above or below a neighbour wakes its tile: water that crossed in a trickle too small to wake it must not leave
   * a slope frozen inside it.
   */
  private settle(): void {
    const T = this.tiles, sx = this.sx, sz = this.sz, depth = this.depth, last = this.last
    const asleep = this.asleep
    asleep.clear()
    for (let k = 0; k < this.list.length; k++) {
      const t = this.list.data[k]!
      const x0 = (t % T.tx) * TILE, z0 = Math.floor(t / T.tx) * TILE, x1 = x0 + TILE, z1 = z0 + TILE
      let live = false, changed = false
      for (let z = z0; z < z1; z++) for (let c = x0 + z * sx, e = c + TILE; c < e; c++) {
        const d = depth[c]!, dd = d - last[c]!
        if (dd === 0) continue
        changed = true
        last[c] = d
        if (dd > DEPTH_EPS || -dd > DEPTH_EPS) live = true
      }
      if (!live) {
        const xa = x0 > 0 ? x0 - 1 : x0, xb = x1 < sx ? x1 : x1 - 1, za = z0 > 0 ? z0 - 1 : z0, zb = z1 < sz ? z1 : z1 - 1
        this.fall = 0; this.span = 0
        for (let z = z0; z < z1 && !live; z++) live = this.runLive(xa + z * sx, xb - xa, 1, 0)
        live ||= ((this.fall < 0 ? -this.fall : this.fall) << SLOPE_SHIFT) > this.span
        this.fall = 0; this.span = 0
        for (let x = x0; x < x1 && !live; x++) live = this.runLive(x + za * sx, zb - za, sx, 1)
        live ||= ((this.fall < 0 ? -this.fall : this.fall) << SLOPE_SHIFT) > this.span
      }
      // Publish what changed: a depth, or an edge that moves water now or did at the last step (its flux may have stopped).
      const moving = this.most[k]! > 0 ? 1 : 0
      if (changed || moving === 1 || T.moving[t] === 1) T.dirty[t] = 1
      T.moving[t] = moving
      if (live) { T.quiet[t] = 0; continue }
      T.quiet[t] = T.quiet[t]! + 1
      if (T.quiet[t]! >= SLEEP_STEPS) { T.awake[t] = 0; T.quiet[t] = 0; asleep.push(t) }
    }
    for (let k = 0; k < asleep.length; k++) this.zeroTile(asleep.data[k]!)
    for (let k = 0; k < this.ring.length; k++) {
      const c = this.ring.data[k]!, x = c % sx, t = T.of(x, (c - x) / sx)
      if (T.awake[t] === 0 && this.headAround(c, x, (c - x) / sx)) T.wake(t)
    }
  }

  /**
   * Scans `edges` edges in a line from column c (step `stride`; `axis` 0: +x edges, 1: +z edges). Live when an edge moved
   * FLUX_EPS or more, or when a run of connected water along the line spans more than HEAD_EPS: a slope that would fall
   * asleep before friction lets its flux build up. An edge connects its columns when the higher one could send (it is at
   * least MIN_FLOW deep; the lower one never sends up, decision 5), or, level, when either could.
   */
  private runLive(c: number, edges: number, stride: number, axis: number): boolean {
    const floor = this.floor, depth = this.depth, flux = this.flux
    let s = floor[c]! * SUB + depth[c]!, lo = s, hi = s, start = s, run = 0
    for (let i = 0; i < edges; i++, c += stride) {
      const f = flux[c * 2 + axis]!
      if (f >= LOUD || -f >= LOUD) return true
      const b = c + stride, da = depth[c]!, db = depth[b]!, sb = floor[b]! * SUB + db
      const up = s > sb ? da : s < sb ? db : da > db ? da : db
      if (up >= MIN_FLOW) {
        if (sb < lo) lo = sb
        else if (sb > hi) hi = sb
        if (hi - lo > HEAD_EPS) return true
        run++
      } else {
        if (run > 0) { this.fall += s - start; this.span += run }
        lo = hi = start = sb
        run = 0
      }
      s = sb
    }
    if (run > 0) { this.fall += s - start; this.span += run }
    return false
  }

  /** Whether column c (at x, z) stands more than HEAD_EPS above or below a neighbour it is connected to. */
  private headAround(c: number, x: number, z: number): boolean {
    const sx = this.sx
    return (x + 1 < sx && this.head(c, c + 1)) || (z + 1 < this.sz && this.head(c, c + sx)) ||
      (x > 0 && this.head(c - 1, c)) || (z > 0 && this.head(c - sx, c))
  }

  /** Whether the edge a → b carries a head above HEAD_EPS that its higher side is deep enough to send down. */
  private head(a: number, b: number): boolean {
    const h = this.floor[a]! * SUB + this.depth[a]! - this.floor[b]! * SUB - this.depth[b]!
    return (h > HEAD_EPS && this.depth[a]! >= MIN_FLOW) || (h < -HEAD_EPS && this.depth[b]! >= MIN_FLOW)
  }

  /** Zeroes the fluxes of a tile that fell asleep, leaving a border edge to a tile that is awake (it moves it from now on). */
  private zeroTile(t: number): void {
    const T = this.tiles, sx = this.sx, sz = this.sz, flux = this.flux, awake = T.awake
    const x0 = (t % T.tx) * TILE, z0 = Math.floor(t / T.tx) * TILE, x1 = x0 + TILE, z1 = z0 + TILE
    const east = x1 < sx && awake[t + 1] === 0, south = z1 < sz && awake[t + T.tx] === 0
    for (let z = z0; z < z1; z++) for (let x = x0, c = x0 + z * sx; x < x1; x++, c++) {
      if (x + 1 < x1 || east) flux[c * 2] = 0
      if (z + 1 < z1 || south) flux[c * 2 + 1] = 0
    }
    if (x0 > 0 && awake[t - 1] === 0) for (let z = z0; z < z1; z++) this.zeroEdge((x0 - 1 + z * sx) * 2, t - 1)
    if (z0 > 0 && awake[t - T.tx] === 0) for (let x = x0; x < x1; x++) this.zeroEdge((x + (z0 - 1) * sx) * 2 + 1, t - T.tx)
    T.dirty[t] = 1
  }

  /** Zeroes a border edge stored in the neighbour tile `owner`; that tile's published flux changes if the edge moved water. */
  private zeroEdge(e: number, owner: number): void {
    if (moved(this.flux[e]!) !== 0) this.tiles.dirty[owner] = 1
    this.flux[e] = 0
  }
}
