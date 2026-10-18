import type { Layout } from '../../world/layout.ts'
import { voxelId } from '../../world/voxel.ts'
import { COST_SCALE, WADE_COST, type NavigationSystem } from './navigation.ts'
import { IdHeap } from './heap.ts'

export const UNREACHED = 0xffff
/**
 * Build steps (pose cells, edges, crossings, field pops and relaxations, and the synchronous passes between phases)
 * charged as one navigation operation: a build step costs a fraction of a flat search's operation, whose neighbour
 * probes read several voxels. Provisional; calibrated by the bench's op-cost and build-cost probes.
 */
export const BUILD_WEIGHT = 4
/** Exits per region that fit in an exit key. */
const MAX_EXITS = 4095, RUN = 8
/**
 * A run of crossings to one neighbour region (a portal), represented by its middle crossing: `from` in the region, `to`
 * beyond it, at `cost`. `crossings` holds every crossing of the run as (from, to) pairs: a unit walking toward the
 * middle crossing crosses at the first one it reaches, so a group keeps up to a run's width of lanes.
 */
export interface Exit { from: number; to: number; cost: number; target: number; crossings: Int32Array }
/** Where crossing the exit from `from` (one of its crossings' `from` poses) lands, or -1. */
export const landing = (exit: Exit, from: number): number => { const c = exit.crossings; for (let i = 0; i < c.length; i += 2) if (c[i] === from) return c[i + 1]!; return -1 }
/** Geometry-only abstract record of one 16³ navigation tile. */
export interface Region {
  index: number; epoch: number
  /**
   * Column index: the slots of column c (x + z*16, local) are colSlots[cols[c] .. cols[c + 1]). A column holds a few
   * poses at most, so a lookup scans them; this replaces a 4,096-cell table (8 KB) with about 0.5 KB + 2 bytes a pose.
   */
  cols: Int16Array
  colSlots: Int16Array
  poses: Int32Array        // slot → world voxel index
  /** 1 where the pose's feet are in water: a step onto it costs WADE_COST more (0 everywhere in a relaxed record). */
  wet: Uint8Array
  /**
   * With surface speeds (NavigationSystem.surfaces), the cost of a flat step onto each pose, by the block under its feet
   * (relaxed records too: a speed change is a geometry change); empty without surfaces.
   */
  flat: Uint16Array
  /** forward edges: 4 per slot, slot of the target inside the region or -1 (edges leaving the region are exits) */
  next: Int16Array
  exits: Exit[]
  /** fields[e * poses.length + slot] = cost from slot to exits[e].from inside the region, UNREACHED if none */
  fields: Uint16Array
  /** More runs than an exit key can address: searches that need this region end limited. */
  overflow: boolean
  /** Bit k set when tile SOURCES[k] may hold poses that step into this region (conservative, from this region's poses). */
  sources: number
  /**
   * `relaxed`: built with poses on falling blocks standable (for landmark tables only). `relaxes`: a relaxed build of
   * this tile would differ, because a pose of it or a crossing target beyond it stands on a falling block.
   */
  relaxed: boolean; relaxes: boolean
  bytes: number
}
/** Fixed per-record overhead counted in `bytes`; tiles with no pose share every array and cost only this. */
const RECORD_BYTES = 64
const NO_POSES = new Int32Array(0), NO_WET = new Uint8Array(0), NO_FLAT = new Uint16Array(0), NO_SLOTS = new Int16Array(0), NO_FIELDS = new Uint16Array(0), NO_COLS = new Int16Array(257), NO_EXITS: Exit[] = Object.freeze([]) as unknown as Exit[]
/** Exit keys used by route and group searches: 1 + region * 4096 + exit index. */
export const exitKey = (region: number, e: number): number => 1 + region * 4096 + e
export const splitKey = (key: number): [region: number, e: number] => [Math.floor((key - 1) / 4096), (key - 1) % 4096]
/**
 * Cost of the region edge from pose `from` (a world index) onto slot `t` of `r`: NavigationSystem.stepCost read from the
 * record (its wet flags and flat costs).
 */
export const regionStepCost = (r: Region, from: number, t: number, L: Layout): number => {
  const plane = L.size[0] * L.size[2], sy = Math.floor(from / plane), ty = Math.floor(r.poses[t]! / plane), wet = r.wet[t] !== 0
  if (!r.flat.length) return 4 + (ty > sy ? 2 : sy - ty) + (wet ? WADE_COST : 0)
  return (ty === sy ? r.flat[t]! : (4 + (ty > sy ? 2 : sy - ty)) * COST_SCALE) + (wet ? WADE_COST * COST_SCALE : 0)
}
export const localOf =(L: Layout, p: number): number => { const [x, y, z] = L.voxelCoords(p); return (x & 15) + ((z & 15) << 4) + ((y & 15) << 8) }
/** Region slot of a world pose, or -1 when it is not a pose of the region. */
export const slotOf = (region: Region, p: number, L: Layout): number => {
  const [x, , z] = L.voxelCoords(p), c = (x & 15) + ((z & 15) << 4)
  for (let i = region.cols[c]!, end = region.cols[c + 1]!; i < end; i++) { const s = region.colSlots[i]!; if (region.poses[s] === p) return s }
  return -1
}
/** Tiles whose poses can step into a tile: the tile below or above, or a face neighbour one tile down, level or up. */
export const SOURCES: readonly (readonly [number, number, number])[] = [[0, -1, 0], [0, 1, 0], ...[-1, 0, 1].flatMap(dy => [[1, dy, 0], [-1, dy, 0], [0, dy, 1], [0, dy, -1]] as [number, number, number][])]
/** Climbs rise one block and drops fall at most two: which source tiles can land on a pose at local (x, y, z). */
function sourceBits(x: number, y: number, z: number): number {
  let bits = 0
  SOURCES.forEach(([dx, dy, dz], k) => {
    const face = dx === 1 ? x === 15 : dx === -1 ? x === 0 : dz === 1 ? z === 15 : dz === -1 ? z === 0 : true
    if (face && (dy === 0 ? dx !== 0 || dz !== 0 : dy < 0 ? y === 0 : y >= 14)) bits |= 1 << k
  })
  return bits
}
interface Crossing { slot: number; d: number; to: number; cost: number; target: number; sy: number; ty: number; along: number; across: number }
type Phase = 'poses' | 'edges' | 'exits' | 'reverse' | 'fields' | 'done'
const PHASES: readonly Phase[] = ['poses', 'edges', 'exits', 'reverse', 'fields', 'done']
export type BuildPhase = Exclude<Phase, 'done'>

/**
 * Builds a Region in slices: one step per cell, edge, crossing, pop or relaxation, and the passes between phases as
 * debt; BUILD_WEIGHT steps are charged as one operation. Restarts if its tile changes. Region poses exclude poses
 * whose support block falls (the live policy always rejects them), so routes never plan across sand.
 */
export class RegionBuild {
  readonly index: number
  done = false
  /** Steps spent per phase, for the bench's cost table; not simulation state. */
  readonly counts: Record<BuildPhase, number> = { poses: 0, edges: 0, exits: 0, reverse: 0, fields: 0 }
  private debt = 0
  private built: Region | null = null
  private readonly nav: NavigationSystem
  private readonly origin: [number, number, number]
  private epoch = 0
  private phase: Phase = 'poses'
  private cursor = 0
  private slots = new Int16Array(4096)
  private locals = new Int16Array(4096)
  private count = 0
  private poses = new Int32Array(0)
  private wet = new Uint8Array(0)
  private flat = NO_FLAT
  private next = new Int16Array(0)
  private degree = new Int32Array(0)
  private revStart = new Int32Array(0)
  private rev = new Int16Array(0)
  private fill = new Int32Array(0)
  private crossings: Crossing[] = []
  private exits: Exit[] = []
  private runs: Crossing[][] = []
  private fields = new Uint16Array(0)
  private cols = NO_COLS
  private colSlots = NO_SLOTS
  private overflow = false
  private sources = 0
  private readonly heap = new IdHeap()
  private field = 0
  private expanding = -1
  private edge = 0
  readonly relaxed: boolean
  private relaxes = false
  constructor(nav: NavigationSystem, index: number, relaxed = false) {
    this.nav = nav; this.index = index; this.relaxed = relaxed
    const tx = nav.port.layout.size[0] >> 4, tz = nav.port.layout.size[2] >> 4
    this.origin = [(index % tx) << 4, Math.floor(index / (tx * tz)) << 4, (Math.floor(index / tx) % tz) << 4]
    this.restart()
  }
  get stage(): Phase { return this.phase }
  private charge(steps: number): void { this.debt += steps; if (this.phase !== 'done') this.counts[this.phase] += steps }
  private restart(): void {
    this.epoch = this.nav.revisions[this.index]!; this.phase = 'poses'; this.cursor = 0; this.count = 0; this.done = false; this.built = null
    this.crossings = []; this.exits = []; this.runs = []; this.overflow = false; this.sources = 0; this.relaxes = false
    this.heap.clear(); this.field = 0; this.expanding = -1; this.edge = 0
    if (this.vacant()) { this.phase = 'done'; this.done = true; this.debt = 1; return }
    this.charge(256); this.slots = new Int16Array(4096).fill(-1)
  }
  /**
   * Whether nothing can stand in the tile, read from chunk uniformity alone: a tile inside a uniform solid chunk has no
   * clear cell, and one inside a uniform open chunk has no support unless it sits on the chunk below (lower half, not
   * the world floor) and that chunk is not uniformly open too.
   */
  private vacant(): boolean {
    const uniform = this.nav.port.uniform, [x, y, z] = this.origin, v = uniform?.(x, y, z)
    if (v === undefined) return false
    const solid = this.nav.port.registry.solid
    if (solid[voxelId(v)]) return true
    if (y & 16) return true
    // The world floor holds units up, except in a void world.
    if (y === 0) return this.nav.voidFloor
    const below = uniform!(x, y - 1, z)
    return below !== undefined && !solid[voxelId(below)]
  }
  private cost(a: number, b: number): number {
    const ya = this.locals[a]! >> 8, yb = this.locals[b]! >> 8
    if (!this.flat.length) return 4 + (yb > ya ? 2 : ya - yb) + (this.wet[b] ? WADE_COST : 0)
    return (ya === yb ? this.flat[b]! : (4 + (yb > ya ? 2 : ya - yb)) * COST_SCALE) + (this.wet[b] ? WADE_COST * COST_SCALE : 0)
  }
  /** Returns charged operations, at most `cap`. */
  step(cap: number): number {
    let used = 0
    if (this.nav.revisions[this.index] !== this.epoch) this.restart()
    if (this.done) { const pay = Math.min(this.debt, cap * BUILD_WEIGHT); this.debt -= pay; return Math.ceil(pay / BUILD_WEIGHT) }
    const L = this.nav.port.layout, [ox, oy, oz] = this.origin, limit = cap * BUILD_WEIGHT
    while (used < limit && !this.done) {
      if (this.debt) { const pay = Math.min(this.debt, limit - used); this.debt -= pay; used += pay; continue }
      used++
      if (this.phase !== 'done') this.counts[this.phase]++
      if (this.phase === 'poses') {
        const c = this.cursor++, x = ox + (c & 15), z = oz + ((c >> 4) & 15), y = oy + (c >> 8)
        const stands = this.nav.stand(x, y, z), region = stands && (this.relaxed || this.nav.regionStand(x, y, z))
        if (stands && !region) this.relaxes = true
        if (region) { this.slots[c] = this.count; this.locals[this.count++] = c; this.sources |= sourceBits(c & 15, c >> 8, (c >> 4) & 15) }
        if (this.cursor === 4096) {
          const P = this.count
          this.poses = new Int32Array(P); this.next = new Int16Array(P * 4).fill(-1); this.degree = new Int32Array(P)
          for (let s = 0; s < P; s++) { const l = this.locals[s]!; this.poses[s] = L.voxelIndex(ox + (l & 15), oy + (l >> 8), oz + ((l >> 4) & 15)) }
          // Landmark tables read relaxed records: no water cost there keeps them a lower bound when water drains.
          this.wet = new Uint8Array(P); if (!this.relaxed) for (let s = 0; s < P; s++) this.wet[s] = this.nav.wet(this.poses[s]!) ? 1 : 0
          this.flat = this.nav.surfaces && P ? new Uint16Array(P) : NO_FLAT
          if (this.nav.surfaces) for (let s = 0; s < P; s++) this.flat[s] = this.nav.flatCost(this.poses[s]!)
          this.charge(2 * P); this.phase = 'edges'; this.cursor = 0
        }
      } else if (this.phase === 'edges') {
        if (this.cursor === this.count * 4) { this.sortCrossings(); this.phase = 'exits'; this.cursor = 0; continue }
        const slot = this.cursor >> 2, d = this.cursor & 3, pose = this.poses[slot]!, to = this.nav.neighbor(pose, d)
        this.cursor++
        if (to < 0) continue
        const target = this.nav.tileOfPose(to)
        // A neighbour the region layer does not stand on (sand) is no edge and no crossing.
        if (target === this.index) { const t = this.slots[localOf(L, to)]!; if (t >= 0) { this.next[slot * 4 + d] = t; this.degree[t]!++ }; continue }
        const [fx, fy, fz] = L.voxelCoords(pose), [tx, ty, tz] = L.voxelCoords(to)
        if (!this.relaxed && !this.nav.regionStand(tx, ty, tz)) { this.relaxes = true; continue }
        this.crossings.push({ slot, d, to, cost: this.nav.stepCost(pose, to, !this.relaxed && this.nav.wet(to)), target, sy: fy, ty, along: d < 2 ? fx : fz, across: d < 2 ? fz : fx })
      } else if (this.phase === 'exits') {
        const cr = this.crossings
        if (this.cursor < cr.length) { this.extend(cr[this.cursor++]!); continue }
        while (this.runs.length) this.closeRun(0)
        if (this.exits.length > MAX_EXITS) { this.overflow = true; this.exits = [] }
        const P = this.count
        this.revStart = new Int32Array(P + 1)
        for (let s = 0; s < P; s++) this.revStart[s + 1] = this.revStart[s]! + this.degree[s]!
        this.rev = new Int16Array(this.revStart[P]!); this.fill = this.revStart.slice(0, P)
        this.charge(P + this.runs.length); this.phase = 'reverse'; this.cursor = 0
      } else if (this.phase === 'reverse') {
        if (this.cursor === this.count) {
          this.fields = new Uint16Array(this.exits.length * this.count).fill(UNREACHED)
          this.phase = 'fields'; this.charge(Math.ceil(this.fields.length / 64)); this.indexColumns(); this.field = 0; this.seed(); continue
        }
        const s = this.cursor++
        for (let d = 0; d < 4; d++) { const t = this.next[s * 4 + d]!; if (t >= 0) this.rev[this.fill[t]!++] = s }
      } else if (this.phase === 'fields') {
        if (this.field === this.exits.length) { this.phase = 'done'; this.done = true; break }
        const P = this.count, f = this.field * P
        if (this.expanding < 0) {
          if (!this.heap.size) { this.field++; this.seed(); continue }
          const g = this.heap.peekF(), s = this.heap.pop()
          if (g === this.fields[f + s]) { this.expanding = s; this.edge = this.revStart[s]! }
          continue
        }
        const s = this.expanding
        if (this.edge === this.revStart[s + 1]) { this.expanding = -1; used--; this.counts.fields--; continue }
        const src = this.rev[this.edge++]!, g = Math.min(UNREACHED - 1, this.fields[f + s]! + this.cost(src, s))
        if (g < this.fields[f + src]!) { this.fields[f + src] = g; this.heap.push(src, g, 0) }
      }
    }
    return Math.ceil(used / BUILD_WEIGHT)
  }
  private sortCrossings(): void {
    const n = this.crossings.length
    this.charge(n ? n * Math.ceil(Math.log2(n + 1)) : 0)
    this.crossings.sort((a, b) => a.d - b.d || a.target - b.target || a.along - b.along || a.across - b.across || a.sy - b.sy || a.ty - b.ty)
  }
  /**
   * Adds a crossing to an open run of the same face and target whose last crossing is its neighbour across the face,
   * with edges both ways between their sources and between their targets: every crossing of a run then reaches its
   * representative and back, on both sides, so one exit per run keeps reachability exact.
   */
  private extend(c: Crossing): void {
    const runs = this.runs, first = runs[0]?.[0]
    if (first && (first.d !== c.d || first.target !== c.target || first.along !== c.along)) while (runs.length) this.closeRun(0)
    for (let i = 0; i < runs.length;) { if (runs[i]!.at(-1)!.across < c.across - 1) this.closeRun(i); else i++ }
    const up = c.d < 2 ? 2 : 0, down = up + 1
    const run = runs.find(r => {
      const last = r.at(-1)!
      return last.across === c.across - 1 && this.next[last.slot * 4 + up] === c.slot && this.next[c.slot * 4 + down] === last.slot
        && this.nav.neighbor(last.to, up) === c.to && this.nav.neighbor(c.to, down) === last.to
    })
    if (run) run.push(c); else runs.push([c])
    const full = runs.findIndex(r => r.length === RUN)
    if (full >= 0) this.closeRun(full)
  }
  private closeRun(i: number): void {
    const run = this.runs.splice(i, 1)[0]!, c = run[Math.floor(run.length / 2)]!, crossings = new Int32Array(run.length * 2)
    run.forEach((x, k) => { crossings[2 * k] = this.poses[x.slot]!; crossings[2 * k + 1] = x.to })
    this.exits.push({ from: this.poses[c.slot]!, to: c.to, cost: c.cost, target: c.target, crossings })
  }
  private seed(): void {
    if (this.field >= this.exits.length) return
    const s = this.slots[localOf(this.nav.port.layout, this.exits[this.field]!.from)]!
    this.fields[this.field * this.count + s] = 0; this.heap.clear(); this.heap.push(s, 0, 0); this.expanding = -1
  }
  /** Groups the slots by column for `slotOf`, in slot order inside each column. */
  private indexColumns(): void {
    const P = this.count
    if (!P) return
    this.charge(P + 257)
    const cols = new Int16Array(257), colSlots = new Int16Array(P)
    for (let s = 0; s < P; s++) cols[(this.locals[s]! & 255) + 1]!++
    for (let c = 0; c < 256; c++) cols[c + 1]! += cols[c]!
    const at = cols.slice(0, 256)
    for (let s = 0; s < P; s++) colSlots[at[this.locals[s]! & 255]!++] = s
    this.cols = cols; this.colSlots = colSlots
  }
  /** The built region; the same record for every query that shared this build. */
  result(): Region {
    if (!this.done) throw new Error('region build is not done')
    if (this.built) return this.built
    const r: Region = this.count
      ? { index: this.index, epoch: this.epoch, cols: this.cols, colSlots: this.colSlots, poses: this.poses, wet: this.wet, flat: this.flat, next: this.next, exits: this.exits, fields: this.fields, overflow: this.overflow, sources: this.sources, relaxed: this.relaxed, relaxes: this.relaxes, bytes: 0 }
      : { index: this.index, epoch: this.epoch, cols: NO_COLS, colSlots: NO_SLOTS, poses: NO_POSES, wet: NO_WET, flat: NO_FLAT, next: NO_SLOTS, exits: NO_EXITS, fields: NO_FIELDS, overflow: false, sources: 0, relaxed: this.relaxed, relaxes: false, bytes: 0 }
    r.bytes = RECORD_BYTES + (this.count ? r.cols.byteLength + r.colSlots.byteLength + r.poses.byteLength + r.wet.byteLength + r.flat.byteLength + r.next.byteLength + r.fields.byteLength + r.exits.reduce((n, x) => n + 48 + x.crossings.byteLength, 0) : 0)
    return this.built = r
  }
  mixState(mix: (n: number) => void): void {
    mix(this.index); mix(this.epoch); mix(this.debt); mix(PHASES.indexOf(this.phase)); mix(this.cursor); mix(this.count); mix(this.crossings.length); mix(this.runs.length); mix(this.exits.length); mix(this.sources); mix(this.relaxed ? 1 : 0); mix(this.relaxes ? 1 : 0)
    mix(this.field); mix(this.expanding); mix(this.edge); this.heap.mixState(mix)
  }
}

/** Cost from a pose (world index) inside the region to every exit; UNREACHED where not connected. */
export function exitCosts(region: Region, pose: number, layout: Layout): number[] {
  const slot = slotOf(region, pose, layout), P = region.poses.length
  return region.exits.map((_, e) => slot < 0 ? UNREACHED : region.fields[e * P + slot]!)
}

/** Reverse Dijkstra inside the region from a set of poses; returns cost per slot (UNREACHED elsewhere). */
export function reverseField(region: Region, targets: readonly number[], layout: Layout): Uint16Array {
  const P = region.poses.length, out = new Uint16Array(P).fill(UNREACHED), heap = new IdHeap()
  const rs = new Int32Array(P + 1)
  for (let s = 0; s < P; s++) for (let d = 0; d < 4; d++) { const t = region.next[s * 4 + d]!; if (t >= 0) rs[t + 1]!++ }
  for (let s = 0; s < P; s++) rs[s + 1]! += rs[s]!
  const rev = new Int32Array(rs[P]!), fill = rs.slice(0, P)
  for (let s = 0; s < P; s++) for (let d = 0; d < 4; d++) { const t = region.next[s * 4 + d]!; if (t >= 0) rev[fill[t]!++] = s }
  for (const p of targets) { const s = slotOf(region, p, layout); if (s >= 0 && out[s] !== 0) { out[s] = 0; heap.push(s, 0, 0) } }
  while (heap.size) {
    const g = heap.peekF(), s = heap.pop()
    if (g !== out[s]) continue
    for (let i = rs[s]!; i < rs[s + 1]!; i++) {
      const src = rev[i]!, c = Math.min(UNREACHED - 1, g + regionStepCost(region, region.poses[src]!, s, layout))
      if (c < out[src]!) { out[src] = c; heap.push(src, c, 0) }
    }
  }
  return out
}

/** Region records by tile, in insertion order; stale records are dropped on read, the oldest evicted past the byte cap. */
export class RegionStore {
  private readonly nav: NavigationSystem
  readonly maxBytes: number
  private readonly regions = new Map<number, Region>()
  private total = 0
  /** Tiles that had a record since the store was cleared, and their count: the prebuild's progress, not simulation state. */
  private readonly once: Uint8Array
  built = 0
  constructor(nav: NavigationSystem, maxBytes = 64 * 1024 * 1024) { this.nav = nav; this.maxBytes = maxBytes; this.once = new Uint8Array(nav.revisions.length) }
  get bytes(): number { return this.total }
  get size(): number { return this.regions.size }
  get(index: number): Region | undefined {
    const r = this.regions.get(index)
    if (!r) return undefined
    if (r.epoch === this.nav.revisions[index]) return r
    this.regions.delete(index); this.total -= r.bytes
    return undefined
  }
  put(region: Region): void {
    const old = this.regions.get(region.index)
    if (old) { this.regions.delete(region.index); this.total -= old.bytes }
    this.regions.set(region.index, region); this.total += region.bytes
    if (!this.once[region.index]) { this.once[region.index] = 1; this.built++ }
    while (this.total > this.maxBytes && this.regions.size > 1) {
      const [index, r] = this.regions.entries().next().value!
      this.regions.delete(index); this.total -= r.bytes
    }
  }
  clear(): void { this.regions.clear(); this.total = 0; this.once.fill(0); this.built = 0 }
}
