import * as K from './constants.ts'
import { ARC_GAP, ARC_REACH, FALL_MIN, fallColumn } from './fall.ts'
import { WaterTiles } from './tiles.ts'
import type { TileEdges, WaterEdges } from './edges.ts'
import type { UnderSegments } from './under.ts'

// Plain module constants: Vitest's module transform turns imported bindings into property reads, several times slower in
// the step's loops.
const { DEPTH_EPS, FLUX_EPS, FLUX_FP, FRICTION_SHIFT, GAIN, HEAD_EPS, MAX_HEAD, MIN_FLOW, SLEEP_STEPS, SLOPE_SHIFT, SUB, THROTTLED_GAIN, TILE } = K

const FRICTION_MASK = (1 << FRICTION_SHIFT) - 1
/** A stored flux this large (either sign) moves FLUX_EPS or more: the edge is not quiet. */
const LOUD = FLUX_EPS << FLUX_FP

/** Sides of a stepped tile whose neighbour tile exists and does not step: their border edges and columns are the tile's. */
const WEST = 1, NORTH = 2, EAST = 4, SOUTH = 8
/** The slope test measures runs of at least this many columns, by the mean of END surfaces at each end. */
const RUN_MIN = 8, END = 4
/** A column thinner than this (1/16 block) shows no water, in the mirror or the renderer: an edge between two such films does not keep a tile awake. */
const SHOWN = SUB / 16
/** Columns past the one beside an edge that a fall can land on (ARC_REACH + ARC_GAP out). */
const FALL_COLUMNS = Math.floor(ARC_REACH + ARC_GAP)
/** A fall's code (WaterColumns.falls) keeps its drop in 1/FALL_DROP_UNITS block above its clear columns (2 bits). */
const FALL_DROP_UNITS = 16
const FALL_DROP_MAX = (1 << 14) - 1

/**
 * The fall code of an edge whose sender stands more than FALL_MIN above the level `level` of the receiver r (both 1/SUB
 * block): its drop, and how many columns past r, going on by `stride` (±1 along x, ±sx along z), the water may fly over
 * before ground higher than that level stops it (at most FALL_COLUMNS; the world's border stops it too).
 */
function fallCode(floor: Int16Array, r: number, stride: number, level: number, drop: number, sx: number, sz: number): number {
  const x = r % sx, z = (r - x) / sx, along = stride === 1 || stride === -1, sign = stride > 0 ? 1 : -1
  let clear = 0
  for (let i = 1; i <= FALL_COLUMNS; i++) {
    const p = (along ? x : z) + i * sign
    if (p < 0 || p >= (along ? sx : sz)) break
    if (floor[r + i * stride]! * SUB > level) break
    clear = i
  }
  return clear | (Math.min(FALL_DROP_MAX, Math.floor((drop * FALL_DROP_UNITS) / SUB)) << 2)
}

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

/**
 * Step 2 for edge e (a → b, b = a + stride): friction, the head, then no flux from a thin film or toward a floor at the
 * sender's surface. An edge whose sender shows water and stands more than FALL_MIN above the receiver, over a brink (its
 * floor above the receiver's surface: the water leaves the ground, unlike a wall of water collapsing), is a fall: its code
 * (fallCode, from the step's starting surfaces, so the order edges move in does not matter) says where transfer lands it.
 */
function accelerate(floor: Int16Array, depth: Int32Array, flux: Int32Array, fall: Uint16Array, e: number, a: number, b: number, gain: number, stride: number, sx: number, sz: number): void {
  const da = depth[a]!, db = depth[b]!
  if (floor[a] === floor[b] && da >= 0 && db >= 0) {
    // Most edges share a bed. The floor cancels from the head and neither side can be a brink.
    let h = da - db
    if (h > MAX_HEAD) h = MAX_HEAD
    else if (h < -MAX_HEAD) h = -MAX_HEAD
    let f = damp(flux[e]!) + h * gain
    if (f > 0 && da < MIN_FLOW || f < 0 && db < MIN_FLOW) f = 0
    flux[e] = f
    fall[e] = 0
    return
  }
  // Dry on both sides and still: the general path's flux is h × gain, zeroed by MIN_FLOW (> 0) on either sign, and no fall.
  if (da === 0 && db === 0 && flux[e] === 0) { fall[e] = 0; return }
  accelerateUneven(floor, depth, flux, fall, e, a, b, gain, stride, sx, sz)
}

/** General edge path, including brinks and ballistic falls. */
function accelerateUneven(floor: Int16Array, depth: Int32Array, flux: Int32Array, fall: Uint16Array, e: number, a: number, b: number, gain: number, stride: number, sx: number, sz: number): void {
  const fa = floor[a]! * SUB, fb = floor[b]! * SUB, da = depth[a]!, db = depth[b]!
  const sa = fa + da, sb = fb + db
  let h = sa - sb
  if (h > MAX_HEAD) h = MAX_HEAD
  else if (h < -MAX_HEAD) h = -MAX_HEAD
  let f = damp(flux[e]!) + h * gain
  if (f > 0) { if (da < MIN_FLOW || sa <= fb) f = 0 }
  else if (f < 0) { if (db < MIN_FLOW || sb <= fa) f = 0 }
  flux[e] = f
  let code = 0
  if (f > 0 && sa - sb > FALL_MIN && fa > sb && da >= SHOWN) code = fallCode(floor, b, stride, sb, sa - sb, sx, sz)
  else if (f < 0 && sb - sa > FALL_MIN && fb > sa && db >= SHOWN) code = fallCode(floor, a, -stride, sa, sb - sa, sx, sz)
  fall[e] = code
}

/** What bodies (Task 6) plug into the step; null until then. */
export interface StepHooks {
  /** Rebuild dirty bodies (after the edges). */
  ensure(): void
  /** Set every boundary edge of each body with an edge collected this step. */
  step(stepping: Uint8Array, gain: number): void
  /** After the transfer: redistribute each stepped body's water; list members to leave. */
  rebalance(): void
  /** A free lower segment reached its capacity this step. */
  filled(i: number): void
  /** Water held as bodies' excess. */
  excessTotal(): number
  mixState(mix: (v: number) => void): void
}

/**
 * Step 2 for under edge e of E: 3c's accelerate without a fall code (plan decision 5); the opening's floor `lo` stands where
 * 3c reads the receiver's floor. Refs below n are top segments.
 */
function accelerateUnder(E: TileEdges, e: number, n: number, floor: Int16Array, depth: Int32Array, uf: Int16Array, ud: Int32Array, gain: number): void {
  const a = E.a[e]!, b = E.b[e]!
  const da = a < n ? depth[a]! : ud[a - n]!, db = b < n ? depth[b]! : ud[b - n]!
  const sa = (a < n ? floor[a]! : uf[a - n]!) * SUB + da, sb = (b < n ? floor[b]! : uf[b - n]!) * SUB + db
  const lo = E.lo[e]! * SUB
  let h = sa - sb
  if (h > MAX_HEAD) h = MAX_HEAD
  else if (h < -MAX_HEAD) h = -MAX_HEAD
  let f = damp(E.flux[e]!) + h * gain
  if (f > 0) { if (da < MIN_FLOW || sa <= lo) f = 0 } else if (f < 0) { if (db < MIN_FLOW || sb <= lo) f = 0 }
  E.flux[e] = f
}

/** Step 3 for column c: scales its outflows (east, south, west, north edges; −1 where none; `extra`: its outflow over under edges) to move at most its depth. Returns the total outflow when it scaled, else 0. */
function limit(depth: Int32Array, flux: Int32Array, c: number, east: number, south: number, west: number, north: number, extra: number): number {
  let out = extra
  if (east >= 0 && flux[east]! > 0) out += flux[east]! >> FLUX_FP
  if (south >= 0 && flux[south]! > 0) out += flux[south]! >> FLUX_FP
  if (west >= 0 && flux[west]! < 0) out += -flux[west]! >> FLUX_FP
  if (north >= 0 && flux[north]! < 0) out += -flux[north]! >> FLUX_FP
  const d = depth[c]!
  if (out <= d) return 0
  if (east >= 0 && flux[east]! > 0) flux[east] = scaled(flux[east]!, d, out)
  if (south >= 0 && flux[south]! > 0) flux[south] = scaled(flux[south]!, d, out)
  if (west >= 0 && flux[west]! < 0) flux[west] = -scaled(-flux[west]!, d, out)
  if (north >= 0 && flux[north]! < 0) flux[north] = -scaled(-flux[north]!, d, out)
  return out
}

/** Interior column: all four edges exist, so read each flux once without per-edge world-boundary checks. */
function limitInterior(depth: Int32Array, flux: Int32Array, c: number, sx: number, extra: number): number {
  const east = c * 2, south = east + 1, west = east - 2, north = (c - sx) * 2 + 1
  const fe = flux[east]!, fs = flux[south]!, fw = flux[west]!, fn = flux[north]!
  const out = extra + (fe > 0 ? fe >> FLUX_FP : 0) + (fs > 0 ? fs >> FLUX_FP : 0)
    + (fw < 0 ? -fw >> FLUX_FP : 0) + (fn < 0 ? -fn >> FLUX_FP : 0)
  const d = depth[c]!
  if (out <= d) return 0
  if (fe > 0) flux[east] = scaled(fe, d, out)
  if (fs > 0) flux[south] = scaled(fs, d, out)
  if (fw < 0) flux[west] = -scaled(-fw, d, out)
  if (fn < 0) flux[north] = -scaled(-fn, d, out)
  return out
}

/** The columns transfer's last fall landed its water on (spot[0..spots)) and what each took. */
const spot = new Int32Array(4), spotTook = new Int32Array(4)
let spots = 0

/** Gives column c `amount` of a fall's water and lists it (spot). */
function land(depth: Int32Array, c: number, amount: number): void {
  depth[c] = depth[c]! + amount
  spot[spots] = c
  spotTook[spots++] = amount
}

/**
 * Lands \`n\` of a fall's water around column c, falling toward \`step\` (±1 along x, ±sx along z): a quarter on each of the
 * columns ahead of it and beside it, the rest on c. A plunging jet spreads where it hits: landed on one column, with no
 * momentum to carry it on, the water would pile up there (half a block and more over a dry floor) until its head pushed
 * it out. Never behind (toward the wall) nor onto higher ground; the floors decide, so the order edges move in does not.
 */
function plunge(depth: Int32Array, floor: Int16Array, sx: number, sz: number, c: number, step: number, n: number): void {
  const x = c % sx, z = (c - x) / sx, along = step === 1 || step === -1, sign = step > 0 ? 1 : -1, q = n >> 2
  let rest = n
  const spread = (ok: boolean, d: number): void => {
    if (!ok || q === 0 || floor[c + d]! > floor[c]!) return
    land(depth, c + d, q)
    rest -= q
  }
  spread(along ? x + sign >= 0 && x + sign < sx : z + sign >= 0 && z + sign < sz, step)
  spread(along ? z > 0 : x > 0, along ? -sx : -1)
  spread(along ? z + 1 < sz : x + 1 < sx, along ? sx : 1)
  land(depth, c, rest)
}

/**
 * Step 4 for edge e (a → b, b = a + stride): moves its water; returns the amount (≥ 0). A fall's water flies over the
 * columns its arc crosses and lands on the one fallColumn gives, as its curtain is drawn, spreading there (plunge).
 */
function transfer(depth: Int32Array, flux: Int32Array, fall: Uint16Array, floor: Int16Array, e: number, a: number, b: number, stride: number, sx: number, sz: number): number {
  if (fall[e] === 0) {
    spots = 0
    const m = moved(flux[e]!)
    if (m === 0) return 0
    depth[a] = depth[a]! - m
    depth[b] = depth[b]! + m
    return m < 0 ? -m : m
  }
  return transferFall(depth, flux, fall, floor, e, a, b, stride, sx, sz)
}

/** Cold transfer path for a ballistic fall and its landing footprint. */
function transferFall(depth: Int32Array, flux: Int32Array, fall: Uint16Array, floor: Int16Array, e: number, a: number, b: number, stride: number, sx: number, sz: number): number {
  spots = 0
  const m = moved(flux[e]!)
  if (m === 0) return 0
  const n = m < 0 ? -m : m, code = fall[e]!
  if (code !== 0) {
    const k = fallColumn(n, ((code >> 2) * SUB) / FALL_DROP_UNITS, code & 3)
    // Thrown out: the sender loses it; the columns the arc crosses (the receiver beside the edge first) are flown over. A
    // trickle that lands at the foot of its wall (k 0) just runs down into the receiver.
    if (k > 0) {
      if (m > 0) { depth[a] = depth[a]! - n; plunge(depth, floor, sx, sz, b + k * stride, stride, n) } else { depth[b] = depth[b]! - n; plunge(depth, floor, sx, sz, a - k * stride, -stride, n) }
      return n
    }
  }
  depth[a] = depth[a]! - m
  depth[b] = depth[b]! + m
  return n
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
  /** Per edge (as flux): where a fall lands the water it moves this step, or 0 for an edge that is not a fall (fallCode). */
  private readonly falls: Uint16Array
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
  /** Tiles that do not step and took a trickle (under FLUX_EPS) this step, once each; settle checks they still lie flat. */
  private readonly trickled = new IntList()
  private readonly trickledMark: Uint8Array
  /** runLive's sums over a tile's runs along one axis (endRun): their falls and their lengths. */
  private fall = 0
  private span = 0
  /** The surfaces of the line runLive scans. */
  private readonly line = new Int32Array(TILE + 2)
  private cursor = 0
  /** Lower segments, their edges and the world's height (attach); null: a single-layer world, stepped exactly as 3c. */
  under: UnderSegments | null = null
  edges: WaterEdges | null = null
  height = 0
  /** Bodies' level for a member ref (set by WaterBodies, Task 6): the surface the quiet test reads for it. */
  bodyLevel: ((ref: number) => number) | null = null
  /** Increments every step: stamps the per-step marks below and TileEdges.seen. */
  stepNo = 0
  private hook: StepHooks | null = null
  /** The under edges this step moves: their tile list (uT) and index there (uE); stepped tile k's run from uStart[k]. */
  private readonly uT = new IntList()
  private readonly uE = new IntList()
  private uStart = new Int32Array(65)
  /** Per top column (n) / lower segment (pool size): outflow over under edges this step, the step that set it, and a sender's scale (depth, outflow) when it was scaled. */
  private topOut = new Int32Array(0)
  private topMark = new Int32Array(0)
  private topLimited = new Int32Array(0)
  private topScaleD = new Int32Array(0)
  private topScaleOut = new Int32Array(0)
  private topScaleMark = new Int32Array(0)
  private underOut = new Int32Array(0)
  private underMark = new Int32Array(0)
  private underScaleD = new Int32Array(0)
  private underScaleOut = new Int32Array(0)
  private underScaleMark = new Int32Array(0)
  private underIn = new Int32Array(0)
  private underInMark = new Int32Array(0)
  /** Per scaled receiver: room not yet given (inflowUnder); per collected edge: its whole inflow before scaling, −1 when not scaled. */
  private underLeft = new Int32Array(0)
  private inWhole = new Int32Array(0)
  /** Per scaled edge: its receiver (lower segment index) and the sign of its flux toward it. */
  private inRecv = new Int32Array(0)
  private inSign = new Int8Array(0)
  private readonly sendersTop = new IntList()
  private readonly sendersUnder = new IntList()
  private readonly receivers = new IntList()

  constructor(sx: number, sz: number, floor: Int16Array) {
    if (floor.length !== sx * sz) throw new RangeError(`floor has ${floor.length} columns, expected ${sx * sz}`)
    this.sx = sx
    this.sz = sz
    this.n = sx * sz
    this.floor = floor
    this.depth = new Int32Array(this.n)
    this.flux = new Int32Array(this.n * 2)
    this.falls = new Uint16Array(this.n * 2)
    this.last = new Int32Array(this.n)
    this.tiles = new WaterTiles(sx, sz)
    this.stepping = new Uint8Array(this.tiles.count)
    this.trickledMark = new Uint8Array(this.tiles.count)
  }

  surface(c: number): number { return this.floor[c]! * SUB + this.depth[c]! }

  /** Steps lower segments too (3d). Without it the step is 3c's. */
  attach(under: UnderSegments, edges: WaterEdges, height: number): void {
    this.under = under
    this.edges = edges
    this.height = height
    this.topOut = new Int32Array(this.n)
    this.topMark = new Int32Array(this.n)
    this.topLimited = new Int32Array(this.n)
    this.topScaleD = new Int32Array(this.n)
    this.topScaleOut = new Int32Array(this.n)
    this.topScaleMark = new Int32Array(this.n)
  }

  hooks(h: StepHooks | null): void { this.hook = h }

  /** Σ depth, with lower segments, their excess and bodies' excess (3d). */
  total(): number {
    let s = 0
    for (let c = 0; c < this.n; c++) s += this.depth[c]!
    if (this.under !== null) s += this.under.total()
    if (this.hook !== null) s += this.hook.excessTotal()
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
      if (this.under !== null) for (let z = z0; z < z0 + TILE; z++) for (let c = x0 + z * sx, e = c + TILE; c < e; c++) {
        for (let i = this.under.first[c]!; i >= 0; i = this.under.next[i]!) if (this.under.depth[i]! > 0) n++
      }
    }
    return n
  }

  /**
   * One step over at most `cap` awake tiles (round robin): accelerate every edge touching them, limit each column's
   * outflow to its depth, move the water, pin the sea columns (`sea` mask, at `seaSurface`), and put quiet tiles to sleep.
   * Returns what the sea columns gave the sea account (negative: what they took from it).
   */
  step(cap: number, sea: Uint8Array | null, seaSurface: number): number {
    const U = this.under
    this.stepNo++
    if (U) {
      this.edges!.ensure(this, U, this.height)
      this.hook?.ensure()
      this.sizeUnder(U)
    }
    this.collect(cap)
    if (U) this.collectUnder(U)
    // The cap left awake tiles out: their borders advance out of phase, which only a lower gain keeps stable.
    const throttled = this.list.length >= cap && this.tiles.awakeCount() > this.list.length
    const gain = throttled ? THROTTLED_GAIN : GAIN
    this.accelerateAll(gain)
    if (U) {
      this.accelerateUnderAll(U, gain)
      this.hook?.step(this.stepping, gain)
      this.sumUnderOut(U)
    }
    this.limitAll()
    if (U) { this.limitUnder(U); this.scaleUnder(U); this.inflowUnder(U) }
    this.transferAll()
    if (U) { this.transferUnder(U); this.hook?.rebalance() }
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
    this.under?.mixState(mix); this.edges?.mixState(mix); this.hook?.mixState(mix)
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

  private accelerateAll(gain: number): void {
    const floor = this.floor, depth = this.depth, flux = this.flux, fall = this.falls, sx = this.sx, sz = this.sz, tx = this.tiles.tx
    const dirty = this.tiles.dirty
    for (let k = 0; k < this.list.length; k++) {
      const t = this.list.data[k]!, o = this.open[k]!
      const x0 = (t % tx) * TILE, z0 = Math.floor(t / tx) * TILE, x1 = x0 + TILE, z1 = z0 + TILE
      const xe = x1 < sx ? x1 : x1 - 1, ze = z1 < sz ? z1 : z1 - 1 // edges leave columns x < xe (+x), rows z < ze (+z)
      for (let z = z0; z < z1; z++) {
        const row = z * sx
        for (let x = x0; x < xe; x++) { const c = x + row; accelerate(floor, depth, flux, fall, c * 2, c, c + 1, gain, 1, sx, sz) }
        if (z < ze) for (let x = x0; x < x1; x++) { const c = x + row; accelerate(floor, depth, flux, fall, c * 2 + 1, c, c + sx, gain, sx, sx, sz) }
      }
      // A border edge stored in a tile that does not step is that tile's to publish: it must republish when the edge's moved
      // water changes, from any value to any other. Here it moved water at the last step; transferAll catches it moving now.
      if ((o & WEST) !== 0) for (let z = z0; z < z1; z++) {
        const c = x0 - 1 + z * sx
        if (moved(flux[c * 2]!) !== 0) dirty[t - 1] = 1
        accelerate(floor, depth, flux, fall, c * 2, c, c + 1, gain, 1, sx, sz)
      }
      if ((o & NORTH) !== 0) for (let x = x0; x < x1; x++) {
        const c = x + (z0 - 1) * sx
        if (moved(flux[c * 2 + 1]!) !== 0) dirty[t - tx] = 1
        accelerate(floor, depth, flux, fall, c * 2 + 1, c, c + sx, gain, sx, sx, sz)
      }
    }
  }

  /** Every column of the stepped tiles, then every ring column: each one's outflows together move at most its depth. */
  private limitAll(): void {
    const depth = this.depth, flux = this.flux, sx = this.sx, sz = this.sz, tx = this.tiles.tx
    // extraOut and limitTop, inline: a column sent over under edges this step (layered and marked) adds its under outflow
    // to limit's, and is then marked limited, with its scale when it scaled.
    const layered = this.under !== null, no = this.stepNo, mark = this.topMark, topOut = this.topOut
    const limited = this.topLimited, scaleD = this.topScaleD, scaleOut = this.topScaleOut, scaleMark = this.topScaleMark
    for (let k = 0; k < this.list.length; k++) {
      const t = this.list.data[k]!
      const x0 = (t % tx) * TILE, z0 = Math.floor(t / tx) * TILE
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0, c = x0 + z * sx; x < x0 + TILE; x++, c++) {
        const sent = layered && mark[c] === no, extra = sent ? topOut[c]! : 0
        const out = x > 0 && z > 0 && x + 1 < sx && z + 1 < sz
          ? limitInterior(depth, flux, c, sx, extra)
          : limit(depth, flux, c, x + 1 < sx ? c * 2 : -1, z + 1 < sz ? c * 2 + 1 : -1, x > 0 ? (c - 1) * 2 : -1, z > 0 ? (c - sx) * 2 + 1 : -1, extra)
        if (sent) {
          limited[c] = no
          if (out > 0) { scaleD[c] = depth[c]!; scaleOut[c] = out; scaleMark[c] = no }
        }
      }
    }
    for (let k = 0; k < this.ring.length; k++) {
      const c = this.ring.data[k]!, x = c % sx, z = (c - x) / sx
      this.limitTop(c, limit(depth, flux, c, x + 1 < sx ? c * 2 : -1, z + 1 < sz ? c * 2 + 1 : -1, x > 0 ? (c - 1) * 2 : -1, z > 0 ? (c - sx) * 2 + 1 : -1, this.extraOut(c)))
    }
  }

  /** Column c's outflow over under edges this step (0 in a single-layer world). */
  private extraOut(c: number): number { return this.under !== null && this.topMark[c] === this.stepNo ? this.topOut[c]! : 0 }

  /** After limit for column c: remember it was limited, and its scale when it scaled (its under edges are scaled alike). */
  private limitTop(c: number, out: number): void {
    // Only collected under-edge senders read these marks in limitUnder/scaleUnder.
    if (this.under === null || this.topMark[c] !== this.stepNo) return
    this.topLimited[c] = this.stepNo
    if (out > 0) { this.topScaleD[c] = this.depth[c]!; this.topScaleOut[c] = out; this.topScaleMark[c] = this.stepNo }
  }

  /** Grows the per-lower-segment scratch to the pool's size. */
  private sizeUnder(U: UnderSegments): void {
    const m = U.col.length
    if (this.underOut.length >= m) return
    this.underOut = new Int32Array(m); this.underMark = new Int32Array(m)
    this.underScaleD = new Int32Array(m); this.underScaleOut = new Int32Array(m); this.underScaleMark = new Int32Array(m)
    this.underIn = new Int32Array(m); this.underInMark = new Int32Array(m); this.underLeft = new Int32Array(m)
  }

  /** The column holding segment ref. */
  private colOf(ref: number, U: UnderSegments): number { return ref < this.n ? ref : U.col[ref - this.n]! }

  /**
   * Every under edge of each stepped tile, plus, on a side whose neighbour tile does not step, that tile's edges reaching
   * into this one (as 3c's border edges). Stamps each collected edge (TileEdges.seen).
   */
  private collectUnder(U: UnderSegments): void {
    const E = this.edges!, sx = this.sx, tx = this.tiles.tx, no = this.stepNo
    this.uT.clear(); this.uE.clear()
    if (this.uStart.length < this.list.length + 1) this.uStart = new Int32Array(this.list.length * 2 + 1)
    const take = (t: number, e: number) => { this.uT.push(t); this.uE.push(e); E.tiles[t]!.seen[e] = no }
    for (let k = 0; k < this.list.length; k++) {
      const t = this.list.data[k]!, o = this.open[k]!
      this.uStart[k] = this.uT.length
      const own = E.tiles[t]
      if (own) for (let e = 0; e < own.count; e++) take(t, e)
      const x0 = (t % tx) * TILE, z0 = Math.floor(t / tx) * TILE
      const w = (o & WEST) !== 0 ? E.tiles[t - 1] : null
      if (w) for (let e = 0; e < w.count; e++) if (w.axis[e] === 0 && this.colOf(w.a[e]!, U) % sx === x0 - 1) take(t - 1, e)
      const nt = (o & NORTH) !== 0 ? E.tiles[t - tx] : null
      if (nt) for (let e = 0; e < nt.count; e++) if (nt.axis[e] === 1 && Math.floor(this.colOf(nt.a[e]!, U) / sx) === z0 - 1) take(t - tx, e)
    }
    this.uStart[this.list.length] = this.uT.length
  }

  /**
   * Accelerates every collected under edge but a body's: a boundary edge is set by its body, an edge inside one carries
   * nothing. An edge stored in a tile that does not step that moved water marks it dirty.
   */
  private accelerateUnderAll(U: UnderSegments, gain: number): void {
    const E = this.edges!, n = this.n, dirty = this.tiles.dirty, stepping = this.stepping
    for (let k = 0; k < this.uT.length; k++) {
      const t = this.uT.data[k]!, e = this.uE.data[k]!, T = E.tiles[t]!, a = T.a[e]!, b = T.b[e]!
      const ma = a >= n && U.body[a - n]! >= 0, mb = b >= n && U.body[b - n]! >= 0
      if (ma || mb) { if (ma && mb) T.flux[e] = 0; continue } // inside a body nothing flows; a boundary edge is the body's
      if (stepping[t] === 0 && moved(T.flux[e]!) !== 0) dirty[t] = 1
      accelerateUnder(T, e, n, this.floor, this.depth, U.floor, U.depth, gain)
    }
  }

  /** Sums each free sender's outflow over the collected under edges (a body caps its own outflow). */
  private sumUnderOut(U: UnderSegments): void {
    const E = this.edges!, n = this.n, no = this.stepNo
    this.sendersTop.clear(); this.sendersUnder.clear()
    for (let k = 0; k < this.uT.length; k++) {
      const T = E.tiles[this.uT.data[k]!]!, e = this.uE.data[k]!, f = T.flux[e]!
      if (f === 0) continue
      const s = f > 0 ? T.a[e]! : T.b[e]!, m = (f > 0 ? f : -f) >> FLUX_FP
      if (s < n) {
        if (this.topMark[s] !== no) { this.topMark[s] = no; this.topOut[s] = 0; this.sendersTop.push(s) }
        this.topOut[s] = this.topOut[s]! + m
      } else {
        const i = s - n
        if (U.body[i]! >= 0) continue
        if (this.underMark[i] !== no) { this.underMark[i] = no; this.underOut[i] = 0; this.sendersUnder.push(i) }
        this.underOut[i] = this.underOut[i]! + m
      }
    }
  }

  /** Senders limitAll did not cover (lower segments, top columns outside the stepped tiles and their ring): scaled on their under outflow alone. */
  private limitUnder(U: UnderSegments): void {
    const no = this.stepNo
    for (let k = 0; k < this.sendersTop.length; k++) {
      const c = this.sendersTop.data[k]!
      if (this.topLimited[c] === no) continue
      const out = this.topOut[c]!, d = this.depth[c]!
      if (out > d) { this.topScaleD[c] = d; this.topScaleOut[c] = out; this.topScaleMark[c] = no }
    }
    for (let k = 0; k < this.sendersUnder.length; k++) {
      const i = this.sendersUnder.data[k]!, out = this.underOut[i]!, d = U.depth[i]!
      if (out > d) { this.underScaleD[i] = d; this.underScaleOut[i] = out; this.underScaleMark[i] = no }
    }
  }

  /** Scales every collected under edge whose sender was scaled, as limit scaled that sender's dense edges. */
  private scaleUnder(U: UnderSegments): void {
    const E = this.edges!, n = this.n, no = this.stepNo
    for (let k = 0; k < this.uT.length; k++) {
      const T = E.tiles[this.uT.data[k]!]!, e = this.uE.data[k]!, f = T.flux[e]!
      if (f === 0) continue
      const s = f > 0 ? T.a[e]! : T.b[e]!, af = f > 0 ? f : -f
      let g = af
      if (s < n) { if (this.topScaleMark[s] === no) g = scaled(af, this.topScaleD[s]!, this.topScaleOut[s]!) }
      else if (this.underScaleMark[s - n] === no) g = scaled(af, this.underScaleD[s - n]!, this.underScaleOut[s - n]!)
      if (g !== af) T.flux[e] = f > 0 ? g : -g
    }
  }

  /**
   * A free lower segment never takes more than its room (cap − depth): its inflows are scaled down together, and the room
   * left by rounding each share down goes 1/SUB at a time to its inflows in collection order, so the shares fill the room
   * exactly. Rounded down alone, several inflows into the last few 1/SUB of room each round to 0: the segment would stop
   * one short of full forever, never join a body, and cap the pressure behind it at its ceiling.
   */
  private inflowUnder(U: UnderSegments): void {
    const E = this.edges!, n = this.n, no = this.stepNo
    this.receivers.clear()
    for (let k = 0; k < this.uT.length; k++) {
      const T = E.tiles[this.uT.data[k]!]!, e = this.uE.data[k]!, f = T.flux[e]!
      if (f === 0) continue
      const r = f > 0 ? T.b[e]! : T.a[e]!
      if (r < n || U.body[r - n]! >= 0) continue
      const i = r - n
      if (this.underInMark[i] !== no) { this.underInMark[i] = no; this.underIn[i] = 0; this.receivers.push(i) }
      this.underIn[i] = this.underIn[i]! + ((f > 0 ? f : -f) >> FLUX_FP)
    }
    let any = false
    for (let k = 0; k < this.receivers.length; k++) {
      const i = this.receivers.data[k]!, room = Math.max(0, U.cap(i) - U.depth[i]!)
      if (this.underIn[i]! > room) { any = true; this.underLeft[i] = room } else this.underInMark[i] = 0 // not over: no scaling
    }
    if (!any) return
    if (this.inWhole.length < this.uT.length) {
      this.inWhole = new Int32Array(this.uT.length * 2); this.inRecv = new Int32Array(this.uT.length * 2); this.inSign = new Int8Array(this.uT.length * 2)
    }
    for (let k = 0; k < this.uT.length; k++) {
      this.inWhole[k] = -1
      const T = E.tiles[this.uT.data[k]!]!, e = this.uE.data[k]!, f = T.flux[e]!
      if (f === 0) continue
      const r = f > 0 ? T.b[e]! : T.a[e]!
      if (r < n || this.underInMark[r - n] !== no) continue
      const i = r - n, af = f > 0 ? f : -f, g = scaled(af, Math.max(0, U.cap(i) - U.depth[i]!), this.underIn[i]!)
      T.flux[e] = f > 0 ? g : -g
      this.underLeft[i] = this.underLeft[i]! - (g >> FLUX_FP)
      this.inWhole[k] = af >> FLUX_FP
      this.inRecv[k] = i
      this.inSign[k] = f > 0 ? 1 : -1
    }
    for (let k = 0; k < this.uT.length; k++) {
      const whole = this.inWhole[k]!
      if (whole < 0) continue
      const T = E.tiles[this.uT.data[k]!]!, e = this.uE.data[k]!, i = this.inRecv[k]!, sign = this.inSign[k]!, f = T.flux[e]!
      if (this.underLeft[i]! > 0 && ((f > 0 ? f : -f) >> FLUX_FP) < whole) {
        T.flux[e] = f + sign * (1 << FLUX_FP)
        this.underLeft[i] = this.underLeft[i]! - 1
      }
    }
  }

  /**
   * Moves the water of every collected under edge. Water reaching a tile that does not step reaches it (wakes it, or is a
   * trickle), and a tile that does not step that loses water is mirrored and published (dirty), as in 3c.
   */
  private transferUnder(U: UnderSegments): void {
    const E = this.edges!, n = this.n, T = this.tiles, sx = this.sx, tx = T.tx, stepping = this.stepping
    const tileOf = (c: number) => { const x = c % sx; return Math.floor(x / TILE) + Math.floor((c - x) / sx / TILE) * tx }
    for (let k = 0, kk = 0; k < this.uT.length; k++) {
      while (kk + 1 < this.list.length && this.uStart[kk + 1]! <= k) kk++
      const L = E.tiles[this.uT.data[k]!]!, e = this.uE.data[k]!, m = moved(L.flux[e]!)
      if (m === 0) continue
      const a = L.a[e]!, b = L.b[e]!
      if (a < n) this.depth[a] = this.depth[a]! - m; else U.depth[a - n] = U.depth[a - n]! - m
      if (b < n) this.depth[b] = this.depth[b]! + m; else U.depth[b - n] = U.depth[b - n]! + m
      const am = m < 0 ? -m : m
      if (am > this.most[kk]!) this.most[kk] = am
      const recv = m > 0 ? b : a, send = m > 0 ? a : b
      const tr = tileOf(this.colOf(recv, U)), ts = tileOf(this.colOf(send, U))
      if (stepping[tr] === 0) this.reach(tr, am)
      if (stepping[ts] === 0) T.dirty[ts] = 1
      if (recv >= n && U.body[recv - n]! < 0 && U.depth[recv - n]! >= U.cap(recv - n)) this.hook?.filled(recv - n)
    }
  }

  /**
   * Moves the water of every edge touching a stepped tile. Water crossing into a tile that does not step reaches it, and so
   * does a fall's water landing in one (landed).
   */
  private transferAll(): void {
    const depth = this.depth, flux = this.flux, fall = this.falls, floor = this.floor, sx = this.sx, sz = this.sz, tx = this.tiles.tx
    for (let k = 0; k < this.list.length; k++) {
      const t = this.list.data[k]!, o = this.open[k]!
      const x0 = (t % tx) * TILE, z0 = Math.floor(t / tx) * TILE, x1 = x0 + TILE, z1 = z0 + TILE
      const xe = x1 < sx ? x1 : x1 - 1, ze = z1 < sz ? z1 : z1 - 1
      let most = 0
      for (let z = z0; z < z1; z++) {
        const row = z * sx
        for (let x = x0; x < xe; x++) {
          const c = x + row, m = transfer(depth, flux, fall, floor, c * 2, c, c + 1, 1, sx, sz)
          if (m > most) most = m
          if (m > 0 && x + 1 === x1 && (o & EAST) !== 0) this.reach(t + 1, m)
          for (let i = 0; i < spots; i++) this.landed(spot[i]!, spotTook[i]!)
        }
        if (z < ze) for (let x = x0; x < x1; x++) {
          const c = x + row, m = transfer(depth, flux, fall, floor, c * 2 + 1, c, c + sx, sx, sx, sz)
          if (m > most) most = m
          if (m > 0 && z + 1 === z1 && (o & SOUTH) !== 0) this.reach(t + tx, m)
          for (let i = 0; i < spots; i++) this.landed(spot[i]!, spotTook[i]!)
        }
      }
      if ((o & WEST) !== 0) for (let z = z0; z < z1; z++) {
        const c = x0 - 1 + z * sx, m = transfer(depth, flux, fall, floor, c * 2, c, c + 1, 1, sx, sz)
        if (m > most) most = m
        if (m > 0) this.reach(t - 1, m)
        for (let i = 0; i < spots; i++) this.landed(spot[i]!, spotTook[i]!)
      }
      if ((o & NORTH) !== 0) for (let x = x0; x < x1; x++) {
        const c = x + (z0 - 1) * sx, m = transfer(depth, flux, fall, floor, c * 2 + 1, c, c + sx, sx, sx, sz)
        if (m > most) most = m
        if (m > 0) this.reach(t - tx, m)
        for (let i = 0; i < spots; i++) this.landed(spot[i]!, spotTook[i]!)
      }
      this.most[k] = most
    }
  }

  /** A fall landed `amount` of water on column c: a tile that does not step takes it as water crossing into it (reach). */
  private landed(c: number, amount: number): void {
    const x = c % this.sx, t = Math.floor(x / TILE) + Math.floor((c - x) / this.sx / TILE) * this.tiles.tx
    if (this.stepping[t] === 0) this.reach(t, amount)
  }

  /** `amount` of water crossed into tile t, which does not step: mirror and publish it, and a real stream wakes it. */
  private reach(t: number, amount: number): void {
    const T = this.tiles
    T.dirty[t] = 1
    if (amount >= FLUX_EPS) T.wake(t)
    else if (this.trickledMark[t] === 0) { this.trickledMark[t] = 1; this.trickled.push(t) }
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
   * DEPTH_EPS since its last step and its water lies flat (flat). After SLEEP_STEPS quiet steps it sleeps, and its fluxes
   * are zeroed, except a border edge whose other tile is still awake after the step: that tile goes on moving it. Then a
   * sleeping tile that water trickled into this step (too little to wake it) is woken if it no longer lies flat: else its
   * neighbours would each go to sleep with a step against it, and those steps would add up to a slope.
   */
  private settle(): void {
    const T = this.tiles, sx = this.sx, depth = this.depth, last = this.last
    const asleep = this.asleep
    asleep.clear()
    for (let k = 0; k < this.list.length; k++) {
      const t = this.list.data[k]!
      const x0 = (t % T.tx) * TILE, z0 = Math.floor(t / T.tx) * TILE
      let live = false, changed = false
      for (let z = z0; z < z0 + TILE; z++) for (let c = x0 + z * sx, e = c + TILE; c < e; c++) {
        const d = depth[c]!, dd = d - last[c]!
        if (dd === 0) continue
        changed = true
        last[c] = d
        if (dd > DEPTH_EPS || -dd > DEPTH_EPS) live = true
      }
      if (this.under !== null) {
        const U = this.under
        for (let z = z0; z < z0 + TILE; z++) for (let c = x0 + z * sx, e = c + TILE; c < e; c++) {
          for (let i = U.first[c]!; i >= 0; i = U.next[i]!) {
            const d = U.depth[i]!, dd = d - U.last[i]!
            if (dd === 0) continue
            changed = true
            U.last[i] = d
            if (dd > DEPTH_EPS || -dd > DEPTH_EPS) live = true
          }
        }
        if (!live) live = this.underLive(k)
      }
      if (!live) live = !this.flat(t)
      // Publish what changed: a depth, or an edge that moves water now or did at the last step (its flux may have stopped).
      const moving = this.most[k]! > 0 ? 1 : 0
      if (changed || moving === 1 || T.moving[t] === 1) T.dirty[t] = 1
      T.moving[t] = moving
      if (live) { T.quiet[t] = 0; continue }
      T.quiet[t] = T.quiet[t]! + 1
      if (T.quiet[t]! >= SLEEP_STEPS) { T.awake[t] = 0; T.quiet[t] = 0; asleep.push(t) }
    }
    for (let k = 0; k < asleep.length; k++) this.zeroTile(asleep.data[k]!)
    const trickled = this.trickled
    for (let k = 0; k < trickled.length; k++) {
      const t = trickled.data[k]!
      this.trickledMark[t] = 0
      if (T.awake[t] === 0 && !this.flat(t)) T.wake(t)
    }
    trickled.clear()
  }

  /**
   * Plan decision 6: stepped tile k is live when one of its collected under edges moved FLUX_EPS or more, or when connected
   * water across one of them (the higher side can send: at least MIN_FLOW deep, and one side shows) differs by more than
   * HEAD_EPS. A body member shows its body's level and counts as deep.
   */
  private underLive(k: number): boolean {
    const E = this.edges!, U = this.under!, n = this.n
    for (let j = this.uStart[k]!; j < this.uStart[k + 1]!; j++) {
      const L = E.tiles[this.uT.data[j]!]!, e = this.uE.data[j]!, f = L.flux[e]!
      if (f >= LOUD || -f >= LOUD) return true
      const a = L.a[e]!, b = L.b[e]!
      const ma = a >= n && U.body[a - n]! >= 0, mb = b >= n && U.body[b - n]! >= 0
      const da = ma ? SUB : a < n ? this.depth[a]! : U.depth[a - n]!
      const db = mb ? SUB : b < n ? this.depth[b]! : U.depth[b - n]!
      const sa = ma && this.bodyLevel ? this.bodyLevel(a) : (a < n ? this.floor[a]! : U.floor[a - n]!) * SUB + (a < n ? this.depth[a]! : U.depth[a - n]!)
      const sb = mb && this.bodyLevel ? this.bodyLevel(b) : (b < n ? this.floor[b]! : U.floor[b - n]!) * SUB + (b < n ? this.depth[b]! : U.depth[b - n]!)
      const up = sa > sb ? da : sb > sa ? db : da > db ? da : db
      if (up >= MIN_FLOW && (da >= SHOWN || db >= SHOWN) && (sa - sb > HEAD_EPS || sb - sa > HEAD_EPS)) return true
    }
    return false
  }

  /**
   * Whether tile t's water lies flat: no edge touching it (its four borders included) moved FLUX_EPS or more, no run of
   * connected water along a row or a column of the tile, extended one column past each border, spans more than HEAD_EPS,
   * and the runs' mean slope along x and along z is at most 1/2^SLOPE_SHIFT per column, with slack (runLive, leaning).
   * This sees the head, not just the water moved, so a gentle slope cannot freeze, and it reads every edge of the tile
   * alike, so a world and its mirror image sleep alike.
   */
  private flat(t: number): boolean {
    const T = this.tiles, sx = this.sx, sz = this.sz
    const x0 = (t % T.tx) * TILE, z0 = Math.floor(t / T.tx) * TILE, x1 = x0 + TILE, z1 = z0 + TILE
    const xa = x0 > 0 ? x0 - 1 : x0, xb = x1 < sx ? x1 : x1 - 1, za = z0 > 0 ? z0 - 1 : z0, zb = z1 < sz ? z1 : z1 - 1
    this.fall = 0; this.span = 0
    for (let z = z0; z < z1; z++) if (this.runLive(xa + z * sx, xb - xa, 1, 0)) return false
    if (this.leaning()) return false
    this.fall = 0; this.span = 0
    for (let x = x0; x < x1; x++) if (this.runLive(x + za * sx, zb - za, sx, 1)) return false
    return !this.leaning()
  }

  /**
   * Scans `edges` edges in a line from column c (step `stride`; `axis` 0: +x edges, 1: +z edges). Live when an edge moved
   * FLUX_EPS or more, or when a run of connected water along the line spans more than HEAD_EPS: a slope that would fall
   * asleep before friction lets its flux build up. An edge connects its columns when the higher one could send (it is at
   * least MIN_FLOW deep; the lower one never sends up, decision 5), or, level, when either could, unless both are films
   * (under SHOWN): a film's level is never drawn, and near MIN_FLOW the integers can hold a film sloped forever. Visible
   * water beside a film still counts, so it cannot stand frozen above it. Each run adds its fall to the tile's slope sums
   * (endRun).
   */
  private runLive(c: number, edges: number, stride: number, axis: number): boolean {
    const floor = this.floor, depth = this.depth, flux = this.flux, line = this.line
    let s = floor[c]! * SUB + depth[c]!, lo = s, hi = s, first = 0
    line[0] = s
    for (let i = 0; i < edges; i++, c += stride) {
      const f = flux[c * 2 + axis]!
      if (f >= LOUD || -f >= LOUD) return true
      const b = c + stride, da = depth[c]!, db = depth[b]!, sb = floor[b]! * SUB + db
      line[i + 1] = sb
      const up = s > sb ? da : s < sb ? db : da > db ? da : db
      if (up >= MIN_FLOW && (da >= SHOWN || db >= SHOWN)) {
        if (sb < lo) lo = sb
        else if (sb > hi) hi = sb
        if (hi - lo > HEAD_EPS) return true
      } else {
        this.endRun(first, i)
        first = i + 1
        lo = hi = sb
      }
      s = sb
    }
    this.endRun(first, edges)
    return false
  }

  /**
   * A run over `line` columns i0..i1 adds to the slope sums: Σ of its last END surfaces − Σ of its first END (its fall, in
   * END × 1/SUB), and the distance between those two windows. Averaging the ends keeps a leftover bump at an end from
   * hiding a slope. A run shorter than RUN_MIN columns (a puddle, a channel's width) is not measured: an odd volume in a
   * two-column pit swaps 1/SUB back and forth forever and must still sleep.
   */
  private endRun(i0: number, i1: number): void {
    if (i1 - i0 + 1 < RUN_MIN) return
    const line = this.line
    let d = 0
    for (let j = 0; j < END; j++) d += line[i1 - j]! - line[i0 + j]!
    this.fall += d
    this.span += i1 - i0 + 1 - END
  }

  /** Whether the slope sums say the tile leans: a mean fall above 1/2^SLOPE_SHIFT per column, plus 1/SUB of slack in all. */
  private leaning(): boolean {
    const f = this.fall < 0 ? -this.fall : this.fall
    return (f << SLOPE_SHIFT) > END * (this.span + (1 << SLOPE_SHIFT))
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
    if (this.edges !== null) {
      const E = this.edges, U = this.under!, own = E.tiles[t]
      if (own) for (let e = 0; e < own.count; e++) {
        const bc = this.colOf(own.b[e]!, U), bx = bc % sx, tb = Math.floor(bx / TILE) + Math.floor((bc - bx) / sx / TILE) * T.tx
        if (tb !== t && awake[tb] === 1) continue // a border edge whose other tile is awake: that tile moves it from now on
        own.flux[e] = 0
      }
      for (const nb of [x0 > 0 ? t - 1 : -1, z0 > 0 ? t - T.tx : -1]) {
        if (nb < 0 || awake[nb] === 1) continue
        const L = E.tiles[nb]
        if (!L) continue
        for (let e = 0; e < L.count; e++) {
          const bc = this.colOf(L.b[e]!, U), bx = bc % sx, tb = Math.floor(bx / TILE) + Math.floor((bc - bx) / sx / TILE) * T.tx
          if (tb !== t) continue
          if (moved(L.flux[e]!) !== 0) T.dirty[nb] = 1
          L.flux[e] = 0
        }
      }
    }
    T.dirty[t] = 1
  }

  /** Zeroes a border edge stored in the neighbour tile `owner`; that tile's published flux changes if the edge moved water. */
  private zeroEdge(e: number, owner: number): void {
    if (moved(this.flux[e]!) !== 0) this.tiles.dirty[owner] = 1
    this.flux[e] = 0
  }
}
