import type { Layout } from '../../world/layout.ts'
import { waterGroupOf, type BlockRegistry } from '../../blocks/registry.ts'
import { voxelId } from '../../world/voxel.ts'
import { RegionBuild, RegionStore, type Region } from './regions.ts'
import { RouteSearch, type RouteOptions } from './routeSearch.ts'
import { GroupField } from './groupField.ts'
import { Landmarks } from './landmarks.ts'

/** `uniform`: the voxel filling the whole chunk at (x, y, z) when the chunk is uniform, so region builds skip tiles nothing stands in. */
export interface NavigationPort { layout: Layout; registry: BlockRegistry; get(x: number, y: number, z: number): number; safe?(x: number, y: number, z: number): boolean; hazard?(x: number, y: number, z: number): boolean; uniform?(x: number, y: number, z: number): number | undefined }
export type PathStatus = 'pending' | 'found' | 'unreachable' | 'limited' | 'stale' | 'cancelled'
export interface PathResult { status: PathStatus; path: number[]; cost: number }
/** A sliced query the navigation budget schedules: flat searches, route searches and group fields. */
export interface NavQuery { status: PathStatus; spent: number; readonly estimate: number; readonly seen: Map<number, number>; step(cap: number): number; cancel(): void; mixState(mix: (n: number) => void): void; readonly bytes: number }
/**
 * `allowed` replaces the port policy for this search; `accept` admits any pose as a goal (h = 0 when there are no explicit
 * goals); `region` confines expansions to one tile, and a search that had to skip a pose outside it ends `limited`;
 * `reversible` takes only steps the unit can take back (no drop it cannot climb again), for walks off a route that must
 * leave the unit its way on.
 */
export interface SearchOptions { allowed?(p: number): boolean; accept?(p: number): boolean; region?: number; reversible?: boolean }
const DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1]
const UNSET = -2
/** First slice of a new search estimated short: such routes finish in it instead of queueing behind long searches. */
const FRESH_SLICE = 512, SHORT_STEPS = 32
/** Long queries sliced together; the rest wait their turn. */
const WINDOW = 8
/** Prebuild rings: tiles within this many columns of an anchor, on its level and the levels above and below. */
const RING = 2
/** Prebuild stops while the region store is fuller than this share of its cap, so it never evicts what queries read. */
const PREBUILD_FILL = 0.9
interface Tile { epoch: number; slots: Int16Array; edges: Int32Array; used: number }
/** Cost of one support edge: 4 per step, +2 for a climb, +1 per block dropped (a ladder edge costs LADDER_COST). */
export const edgeCost = (L: Layout, from: number, to: number): number => { const plane = L.size[0] * L.size[2], sy = Math.floor(from / plane), ty = Math.floor(to / plane); return 4 + (ty > sy ? 2 : sy - ty) }
/** Extra planning cost of a step onto a pose whose feet are in water: wading counts as about three steps, so routes keep to dry land unless going round is much longer. Walking speed is the same. */
export const WADE_COST = 8
/**
 * Cost (unscaled) of one ladder edge, up or down one rung; its motion takes LADDER_TICKS. At least the heuristics' cost per
 * block risen, so they stay admissible.
 */
export const LADDER_COST = 12
/**
 * With surface speeds configured, every base cost (a step, a climb, a drop, wading) is multiplied by this, so a flat step
 * onto a block of speed s can cost round(4 × COST_SCALE / s) in whole numbers. Without surfaces costs stay unscaled.
 */
export const COST_SCALE = 4
/** Most a flat step may cost (a very slow surface), so region fields (Uint16) keep their headroom. */
const MAX_FLAT = 4095
/**
 * Edge costs with surface speeds. `flat[id]`: the cost of a flat step onto a pose standing on block `id`; climbs, drops
 * and wading keep their base cost × COST_SCALE (their timing does not change with the floor). `step` and `climb`: the
 * lower bounds the heuristics use per planar step (at the fastest configured speed) and per block risen.
 */
export interface SurfaceCosts { flat: Uint16Array; step: number; climb: number; maxFlat: number }
/** Surface costs from speeds by block id (1 where none is set). */
export function surfaceCosts(speeds: Float64Array): SurfaceCosts {
  let max = 1, maxFlat = 4 * COST_SCALE
  const flat = new Uint16Array(speeds.length)
  for (let id = 0; id < speeds.length; id++) { const s = speeds[id]!; max = Math.max(max, s); flat[id] = Math.min(MAX_FLAT, Math.max(1, Math.round(4 * COST_SCALE / s))); maxFlat = Math.max(maxFlat, flat[id]!) }
  return { flat, step: Math.max(1, Math.floor(4 * COST_SCALE / max)), climb: 2 * COST_SCALE, maxFlat }
}
/**
 * Ticks a tile holds its liquid changes before the region layer sees them, in one revision bump. Water at a river's edge
 * flickers many times a tick; bumping on each change restarted every build and search over it. Until then the live policy
 * (and wading on through water up to 1.5 blocks) covers the difference.
 */
export const WATER_SETTLE = 200

/** Lazy support graph. Geometry only: live occupancy, water and structural safety are checked by the executor. */
export class NavigationSystem {
  readonly port: NavigationPort
  readonly revisions: Uint32Array
  revision = 0
  /** Bumped by every change of solid geometry (not by the falls rule alone): landmark tables are valid for one count. */
  geometry = 0
  /**
   * Tiles where the falls rule alone has changed (sand that got wet or dried, say), and a count bumped each time a tile
   * joins them: landmark tables treat poses on falling blocks in and next to those tiles as standable.
   */
  readonly flippy: Uint8Array
  flips = 0
  visited = 0
  private readonly tiles = new Map<number, Tile>()
  private readonly tx: number
  private readonly tz: number
  private requests: NavQuery[] = []
  /** Geometry-only region records shared by route and group queries. */
  readonly regions: RegionStore
  /** Region builds in progress by tile, shared by the queries that need them. */
  readonly building = new Map<number, RegionBuild>()
  /** Landmark tables (ALT heuristic) for route and group searches, computed by the prebuild. */
  readonly landmarks = new Landmarks(this)
  /**
   * Background prebuild cursor: phase 0 walks rings around the anchors (ring, anchor, k), phase 1 every tile by index
   * (tile); `built` counts tiles built this pass, and a pass that built none sets `prebuilt`.
   */
  private readonly pre = { phase: 0, ring: 0, anchor: 0, k: 0, tile: 0, built: 0, idle: -1 }
  /** A whole prebuild pass found every tile current. */
  prebuilt = false
  /** Prebuild passes completed: after the first one every tile was built once (a warm world). Not simulation state. */
  prebuildPasses = 0
  /** Tiles changed since the first complete prebuild pass, in the order they changed; `inQueue` marks them. */
  private readonly changed: number[] = []
  private readonly inQueue: Uint8Array
  /** Every tile was built and the landmark tables settled once since the last reset: background work is capped from then on. */
  warmed = false
  /** Per tile, the tick its first unapplied liquid change came (-1: none); `wetPending` lists them in that order. */
  private readonly wetSince: Int32Array
  private readonly wetPending: number[] = []
  /** Tiles the last prebuild call looked at (instrumentation; not simulation state). */
  prebuildChecks = 0
  private cursor = 0
  /** The tile the last edge read: the four edges of a pose skip the map. Always the map's entry for `lastTile`. */
  private lastTile = -1
  private last: Tile | null = null
  readonly maxNodes: number
  readonly cacheLimit: number
  /** The simulated water's block id (0 without one): units wade in it; any other liquid or a spring in the feet cell is no pose. */
  private readonly waterGroup: number
  /** World x size and x × z plane, to decode pose indices without allocating. */
  readonly sx: number
  readonly plane: number
  /**
   * Edges per pose: the four planar ones (+x −x +z −z), then up (4) and down (5) along a ladder when any block is
   * climbable. A world without climbable blocks keeps four, and every edge, cost and route it had.
   */
  readonly dirs: 4 | 6
  private readonly climbable: Uint8Array
  /**
   * Bumped by every step and every edit or policy change. Between bumps nothing the live policy reads can change, so a
   * search may remember the poses it rejected for the rest of the pass.
   */
  pass = 0
  constructor(port: NavigationPort, maxNodes = 16384, cacheLimit = 512, storeBytes = 64 * 1024 * 1024) {
    if (port.layout.voxelCount > 0x80000000) throw new RangeError('navigation needs voxel indices to fit positive int32')
    this.maxNodes = maxNodes; this.cacheLimit = cacheLimit
    this.sx = port.layout.size[0]; this.plane = port.layout.size[0] * port.layout.size[2]
    this.port = port; this.waterGroup = waterGroupOf(port.registry); this.tx = port.layout.size[0] >> 4; this.tz = port.layout.size[2] >> 4
    this.dirs = port.registry.hasClimbable ? 6 : 4; this.climbable = port.registry.climbable
    this.revisions = new Uint32Array(this.tx * this.tz * (port.layout.size[1] >> 4)); this.flippy = new Uint8Array(this.revisions.length)
    this.inQueue = new Uint8Array(this.revisions.length); this.wetSince = new Int32Array(this.revisions.length).fill(-1)
    this.regions = new RegionStore(this, storeBytes)
  }
  get pending(): number { let n = 0; for (const s of this.requests) if (s.status === 'pending') n++; return n }
  get cacheTiles(): number { return this.tiles.size }
  get bytes(): number {
    let n = this.revisions.byteLength + this.regions.bytes
    for (const t of this.tiles.values()) n += t.slots.byteLength + t.edges.byteLength
    for (const s of this.requests) n += s.bytes
    return n + this.landmarks.bytes
  }
  tileOf(x: number, y: number, z: number): number { return (x >> 4) + (z >> 4) * this.tx + (y >> 4) * this.tx * this.tz }
  tileOfPose(p: number): number { const y = (p / this.plane) | 0, r = p - y * this.plane, z = (r / this.sx) | 0; return this.tileOf(r - z * this.sx, y, z) }
  /**
   * `solid`: whether solid geometry changed (that retires the landmark tables); `falls`: whether only the falls rule
   * changed (sand that got wet or dried), which marks the tiles `flippy`. A change of neither (a structural role) does
   * neither.
   */
  invalidate(x: number, y: number, z: number, solid = true, falls = !solid): void { this.invalidateBox(x, y, z, x, y, z, solid, falls) }
  /**
   * Liquid appeared in, left or changed kind in voxel (x, y, z): the pose below it (y - 1) changed its head-cell rule,
   * and the pose at y its feet rule (a spring or another liquid). Like a falls flip, it marks the tiles flippy (landmark tables then read those poses as standable, so they
   * stay a lower bound) and bumps their revisions; it is no change of solid geometry.
   */
  invalidateLiquid(x: number, y: number, z: number, now = 0): void {
    // The same tiles invalidateBox would bump for (x, y - 1, z)..(x, y, z); they are bumped by settleWater, WATER_SETTLE later.
    const [sx, sy, sz] = this.port.layout.size, plane = this.tx * this.tz
    for (let yy = Math.max(0, (Math.max(0, y - 1) - 2) >> 4); yy <= Math.min((sy >> 4) - 1, (y + 3) >> 4); yy++)
      for (let zz = Math.max(0, (z - 1) >> 4); zz <= Math.min((sz >> 4) - 1, (z + 1) >> 4); zz++)
        for (let xx = Math.max(0, (x - 1) >> 4); xx <= Math.min((sx >> 4) - 1, (x + 1) >> 4); xx++) {
          const t = xx + zz * this.tx + yy * plane
          if (this.wetSince[t]! < 0) { this.wetSince[t] = now; this.wetPending.push(t) }
        }
  }
  /** Applies the liquid changes tiles have held for WATER_SETTLE ticks: one revision bump each, marking them flippy. */
  settleWater(now: number): void {
    let bumped = false
    while (this.wetPending.length && now - this.wetSince[this.wetPending[0]!]! >= WATER_SETTLE) {
      const t = this.wetPending.shift()!
      this.wetSince[t] = -1; this.revisions[t]!++; bumped = true
      if (!this.flippy[t]) { this.flippy[t] = 1; this.flips++ }
      if (!this.inQueue[t]) { this.inQueue[t] = 1; this.changed.push(t) }
    }
    if (bumped) { this.revision++; this.pass++ }
  }
  /** Edges of a pose read x±1, z±1 and y-3..y+2, so a voxel change reaches only poses in that reverse footprint. */
  invalidateBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, solid = true, falls = !solid): void {
    if (solid) this.geometry++
    const flippy = this.flippy, plane = this.tx * this.tz
    const [sx, sy, sz] = this.port.layout.size
    for (let yy = Math.max(0, (y0 - 2) >> 4); yy <= Math.min((sy >> 4) - 1, (y1 + 3) >> 4); yy++)
      for (let zz = Math.max(0, (z0 - 1) >> 4); zz <= Math.min((sz >> 4) - 1, (z1 + 1) >> 4); zz++)
        for (let xx = Math.max(0, (x0 - 1) >> 4); xx <= Math.min((sx >> 4) - 1, (x1 + 1) >> 4); xx++) {
          const t = xx + zz * this.tx + yy * plane
          this.revisions[t]!++
          if (falls && !solid && !flippy[t]) { flippy[t] = 1; this.flips++ }
          if (!this.inQueue[t]) { this.inQueue[t] = 1; this.changed.push(t) }
        }
    this.revision++; this.pass++
  }
  reset(): void {
    this.tiles.clear(); this.lastTile = -1; this.last = null; this.regions.clear(); this.building.clear(); this.revisions.fill(0); this.revision++; this.pass++; for (const s of this.requests) s.cancel(); this.requests = []
    Object.assign(this.pre, { phase: 0, ring: 0, anchor: 0, k: 0, tile: 0, built: 0, idle: -1 }); this.prebuilt = false; this.prebuildPasses = 0
    this.geometry++; this.flippy.fill(0); this.flips++; this.landmarks.reset(); this.changed.length = 0; this.inQueue.fill(0); this.warmed = false; this.wetPending.length = 0; this.wetSince.fill(-1)
  }
  /**
   * Changes to allowed poses invalidate queries without discarding the geometry graph; a box limits it to searches that
   * expanded next to it. Route and group queries read geometry only, so policy never cancels them.
   */
  invalidatePolicy(min?: readonly number[], max?: readonly number[]): void {
    this.revision++; this.pass++
    for (const s of this.requests) if (s instanceof PathSearch && (!min || !max || this.explored(s, min, max))) s.cancel()
  }
  /** Whether a search expanded a pose with an edge that may reach a pose in the voxel box [min, max]. */
  explored(s: NavQuery, min: readonly number[], max: readonly number[]): boolean {
    const x0 = (min[0]! - 1) >> 4, x1 = (max[0]! + 1) >> 4, y0 = (min[1]! - 3) >> 4, y1 = (max[1]! + 2) >> 4, z0 = (min[2]! - 1) >> 4, z1 = (max[2]! + 1) >> 4
    for (const ti of s.seen.keys()) {
      const x = ti % this.tx, z = Math.floor(ti / this.tx) % this.tz, y = Math.floor(ti / (this.tx * this.tz))
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1) return true
    }
    return false
  }
  clear(x: number, y: number, z: number): boolean {
    return this.port.layout.inBounds(x, y, z) && this.port.registry.solid[voxelId(this.port.get(x, y, z))] === 0
  }
  /** Void world (spec §3): the bottom of the volume is no support. */
  voidFloor = false
  /** Surface speeds (WorkerOptions.surfaces), or null: costs are then exactly the unscaled ones. Set once, before any search. */
  surfaces: SurfaceCosts | null = null
  /** Heuristic lower bounds per planar step and per block risen: 4 and 2 unscaled. */
  get minStep(): number { return this.surfaces ? this.surfaces.step : 4 }
  get minClimb(): number { return this.surfaces ? this.surfaces.climb : 2 }
  /** What one unscaled cost unit is worth in this navigation's costs: COST_SCALE with surfaces, else 1 (accesses review I3). */
  get costScale(): number { return this.surfaces ? COST_SCALE : 1 }
  /**
   * Planning cost of the step from pose `from` to pose `to` (one of its edges): 4, +2 for a climb, +1 per block dropped,
   * + WADE_COST onto water; with surfaces all × COST_SCALE, except that a flat step costs its floor's flat cost.
   */
  stepCost(from: number, to: number, wet = this.wet(to)): number {
    const plane = this.plane, sy = (from / plane) | 0, ty = (to / plane) | 0, S = this.surfaces
    // Planar edges always change column: a same-column edge is a ladder's (never wet: its feet cell holds the ladder).
    if (this.dirs === 6 && (to - from === plane || from - to === plane)) return this.ladderCost
    if (!S) return 4 + (ty > sy ? 2 : sy - ty) + (wet ? WADE_COST : 0)
    return (ty === sy ? this.flatCost(to) : (4 + (ty > sy ? 2 : sy - ty)) * COST_SCALE) + (wet ? WADE_COST * COST_SCALE : 0)
  }
  /** With surfaces, the cost of a flat step onto pose p, by the block under its feet (block 0 on the world floor). */
  flatCost(p: number): number {
    const S = this.surfaces!, y = (p / this.plane) | 0
    if (y === 0) return S.flat[0]!
    const r = p - y * this.plane, z = (r / this.sx) | 0
    return S.flat[voxelId(this.port.get(r - z * this.sx, y - 1, z))]!
  }
  /** A ladder edge's cost: LADDER_COST, × COST_SCALE with surfaces. */
  get ladderCost(): number { return this.surfaces ? LADDER_COST * COST_SCALE : LADDER_COST }
  /** Whether the cell holds a climbable block (false out of bounds). */
  climbableAt(x: number, y: number, z: number): boolean {
    return this.dirs === 6 && this.port.layout.inBounds(x, y, z) && this.climbable[voxelId(this.port.get(x, y, z))] === 1
  }
  /** Feet and head clear, on a solid floor (the world floor unless void) or with the feet in a climbable cell (a rung). */
  stand(x: number, y: number, z: number): boolean {
    return this.clear(x, y, z) && this.clear(x, y + 1, z) && ((y === 0 ? !this.voidFloor : this.port.registry.solid[voxelId(this.port.get(x, y - 1, z))] === 1) || this.climbableAt(x, y, z))
  }
  /**
   * A pose of the region layer: it stands, not on a block that falls, not with liquid in the head cell, and not with a
   * spring or a liquid other than water in the feet cell. The live policy always rejects all three (units wade through
   * water up to one block, never with the head under), so the region layer drops them as geometry; flat searches still
   * stand there (to search out of sand or deep water).
   */
  regionStand(x: number, y: number, z: number): boolean {
    const R = this.port.registry, feet = voxelId(this.port.get(x, y, z))
    return this.stand(x, y, z) && (y === 0 || R.falls[voxelId(this.port.get(x, y - 1, z))] !== 1 || this.climbableAt(x, y, z))
      && !(R.liquid[feet] === 1 && (R.liquidGroup[feet] !== this.waterGroup || R.source[feet] === 1))
      && (y + 1 >= this.port.layout.size[1] || R.liquid[voxelId(this.port.get(x, y + 1, z))] !== 1)
  }
  /** Whether the feet cell of pose p holds liquid: a step onto it costs WADE_COST more. */
  wet(p: number): boolean { const y = (p / this.plane) | 0, r = p - y * this.plane, z = (r / this.sx) | 0; return this.port.registry.liquid[voxelId(this.port.get(r - z * this.sx, y, z))] === 1 }
  allowed(p: number): boolean {
    const y = (p / this.plane) | 0, r = p - y * this.plane, z = (r / this.sx) | 0, x = r - z * this.sx
    return (this.port.safe?.(x, y, z) ?? true) && !(this.port.hazard?.(x, y, z) ?? false)
  }
  /** Records tile `ti` in a search's `seen` with the revision it was first read at. */
  see(seen: Map<number, number>, ti: number): void { if (!seen.has(ti)) seen.set(ti, this.revisions[ti]!) }
  neighbor(p: number, d: number, seen?: Map<number, number>): number {
    const y = (p / this.plane) | 0, r = p - y * this.plane, z = (r / this.sx) | 0, x = r - z * this.sx, ti = this.tileOf(x, y, z)
    if (seen) this.see(seen, ti)
    return this.edge(x, y, z, ti, d)
  }
  /** The support edge `d` of pose (x, y, z) in tile `ti`, or -1: planar (0–3: flat, climb or drop), or along a ladder (4 up, 5 down; only when `dirs` is 6) onto a climbable pose. */
  edge(x: number, y: number, z: number, ti: number, d: number): number {
    const L = this.port.layout
    let tile = ti === this.lastTile ? this.last : this.tiles.get(ti)
    if (!tile || tile.epoch !== this.revisions[ti]) {
      if (!tile && this.tiles.size >= this.cacheLimit) this.tiles.delete(this.tiles.keys().next().value!)
      tile = { epoch: this.revisions[ti]!, slots: new Int16Array(4096).fill(-1), edges: new Int32Array(256 * this.dirs).fill(UNSET), used: 0 }; this.tiles.set(ti, tile)
    }
    this.lastTile = ti; this.last = tile
    const local = (x & 15) + ((z & 15) << 4) + ((y & 15) << 8)
    let slot = tile.slots[local]!
    if (slot < 0) {
      slot = tile.used++; tile.slots[local] = slot
      if (slot * this.dirs === tile.edges.length) { const a = new Int32Array(tile.edges.length * 2).fill(UNSET); a.set(tile.edges); tile.edges = a }
    }
    const off = slot * this.dirs + d
    if (tile.edges[off] !== UNSET) return tile.edges[off]!
    if (d >= 4) {
      const ny = d === 4 ? y + 1 : y - 1
      return tile.edges[off] = this.climbableAt(x, ny, z) && this.stand(x, ny, z) ? L.voxelIndex(x, ny, z) : -1
    }
    const nx = x + DX[d]!, nz = z + DZ[d]!
    let ny = -1
    if (this.stand(nx, y, nz)) ny = y
    else if (this.stand(nx, y + 1, nz) && this.clear(x, y + 2, z)) ny = y + 1
    else if (this.clear(nx, y, nz) && this.clear(nx, y + 1, nz)) for (let drop = 1; drop <= 2; drop++) {
      if (this.stand(nx, y - drop, nz)) { ny = y - drop; break }
      if (!this.clear(nx, y - drop, nz)) break
    }
    return tile.edges[off] = ny < 0 ? -1 : L.voxelIndex(nx, ny, nz)
  }
  request(start: number, goals: readonly number[], blocked?: ReadonlySet<number>, options?: SearchOptions): PathSearch {
    const s = new PathSearch(this, start, goals, blocked, options); this.requests.push(s); return s
  }
  /**
   * The current record of a tile, from the store or by stepping its build (shared with the queries building it) with
   * at most `cap` operations; `region` is undefined while the build still runs.
   */
  regionNow(index: number, cap: number): { region: Region | undefined; used: number } {
    const known = this.regions.get(index)
    if (known || cap <= 0) return { region: known, used: 0 }
    let job = this.building.get(index)
    if (!job) { job = new RegionBuild(this, index); this.building.set(index, job) }
    const used = job.step(cap)
    if (!job.done) return { region: undefined, used }
    const r = job.result()
    if (this.building.get(index) === job) this.building.delete(index)
    if (this.regions.get(index) !== r) this.regions.put(r)
    return { region: r, used }
  }
  /**
   * Builds regions ahead of need with operations the tick left unused, in a fixed order: the tiles within RING columns
   * of each anchor (a unit's tile; ring by ring, anchors in order, each on its level and the ones above and below), then
   * every tile by index. After that first complete pass only the tiles changed since (the `changed` queue, oldest first)
   * are rebuilt: no rings and no rescans. One operation per tile checked, builds charged as usual,
   * a build in progress resumed first; nothing while the store is fuller than PREBUILD_FILL of its cap, nor after a
   * pass that built nothing until a tile changes. Once every tile was built, landmark tables go before the passes;
   * `now` (the tick) lets them wait for edits to settle (see Landmarks). Returns the operations used, at most `cap`.
   */
  prebuild(cap: number, anchors: readonly number[], now?: number): number {
    let used = 0
    this.prebuildChecks = 0
    const pre = this.pre, tx = this.tx, tz = this.tz, ty = this.revisions.length / (tx * tz)
    // Builds that queries or refinement left unfinished go first, oldest first, so none lingers half built; a store too
    // full to take them drops them instead (a reader still building one keeps its own).
    if (this.full) this.building.clear()
    for (const index of this.building.keys()) {
      if (used >= cap) break
      const { region, used: spent } = this.regionNow(index, cap - used)
      used += spent
      if (!region) break
    }
    if (used < cap && !this.full && this.regions.built === this.revisions.length) used += this.landmarks.step(cap - used, now)
    // After the first complete pass, only tiles that changed since are rebuilt, oldest change first: no rings, no rescans.
    if (this.prebuildPasses > 0) {
      while (this.changed.length && used < cap && !this.full) {
        const tile = this.changed[0]!
        used++; this.prebuildChecks++
        if (!this.regions.get(tile)) {
          const { region, used: spent } = this.regionNow(tile, cap - used)
          used += spent
          if (!region) break
        }
        this.changed.shift(); this.inQueue[tile] = 0
      }
    } else while (pre.idle !== this.revision && used < cap && !this.full) {
      let tile = -1
      if (pre.phase === 0) {
        // Ring r has 8r columns (1 for r = 0), each on three levels.
        const r = pre.ring, side = 2 * r + 1, columns = r ? 8 * r : 1
        if (r > RING) { pre.phase = 1; pre.ring = 0; continue }
        if (pre.anchor >= anchors.length) { pre.ring++; pre.anchor = 0; pre.k = 0; continue }
        if (pre.k >= columns * 3) { pre.anchor++; pre.k = 0; continue }
        const a = anchors[pre.anchor]!, ax = a % tx, az = Math.floor(a / tx) % tz, ay = Math.floor(a / (tx * tz))
        const c = Math.floor(pre.k / 3), level = ay + (pre.k % 3) - 1
        // Walk the ring's perimeter from its corner: top edge, right edge, bottom edge, left edge.
        const edge = r ? Math.floor(c / (side - 1)) : 0, at = r ? c % (side - 1) : 0
        const dx = r === 0 ? 0 : edge === 0 ? -r + at : edge === 1 ? r : edge === 2 ? r - at : -r
        const dz = r === 0 ? 0 : edge === 0 ? -r : edge === 1 ? -r + at : edge === 2 ? r : r - at
        const x = ax + dx, z = az + dz
        if (x >= 0 && z >= 0 && x < tx && z < tz && level >= 0 && level < ty) tile = x + z * tx + level * tx * tz
      } else {
        if (pre.tile >= this.revisions.length) {
          this.prebuilt = pre.built === 0; this.prebuildPasses++
          Object.assign(pre, { phase: 0, ring: 0, anchor: 0, k: 0, tile: 0, built: 0, idle: this.prebuilt ? this.revision : -1 })
          // A pass with nothing to build: the next one waits for a change.
          if (this.prebuilt) break
          continue
        }
        tile = pre.tile
      }
      if (tile < 0) { pre.k++; continue }
      used++; this.prebuildChecks++
      if (this.regions.get(tile)) { if (pre.phase === 0) pre.k++; else pre.tile++; continue }
      const { region, used: spent } = this.regionNow(tile, cap - used)
      used += spent
      if (!region) break
      pre.built++
      if (pre.phase === 0) pre.k++; else pre.tile++
    }
    // A store too full to take more leaves prebuild nothing to do either.
    if (this.full) this.prebuilt = true
    if (!this.warmed && (this.regions.built === this.revisions.length && this.landmarks.settled() || this.full)) this.warmed = true
    this.visited += used
    return used
  }
  /** Whether the region store is too full for the prebuild to go on. */
  private get full(): boolean { return this.regions.bytes >= this.regions.maxBytes * PREBUILD_FILL }
  /**
   * Prebuild progress, for warm-ups: `built` tiles have had a record since the last reset, of `ground` (every tile of the
   * world needs one; an empty tile shares a 64-byte record), `queued` never had one. Done once every tile was built, or
   * once the store is too full for the prebuild to go on (then built < ground); with every tile built, the landmark
   * tables must be current too. Edits later rebuild in the background and leave the regions warm.
   */
  prebuildStatus(): { built: number; ground: number; queued: number; bytes: number; capBytes: number; landmarks: boolean; done: boolean } {
    const ground = this.revisions.length, built = this.regions.built, landmarks = this.landmarks.current() !== null
    return { built, ground, queued: ground - built, bytes: this.regions.bytes, capBytes: this.regions.maxBytes, landmarks, done: built === ground && this.landmarks.settled() || this.full }
  }
  /** A hierarchical route over region exits; `seen` is keyed by region index, which is the tile index. */
  route(start: number, goals: readonly number[], options?: RouteOptions): RouteSearch {
    const s = new RouteSearch(this, this.regions, start, goals, options); this.requests.push(s); return s
  }
  /** One reverse abstract search from the goals that every start descends. */
  group(goals: readonly number[], starts: readonly number[]): GroupField {
    const s = new GroupField(this, this.regions, goals, starts); this.requests.push(s); return s
  }
  step(cap: number): void {
    this.visited = 0; this.pass++
    this.requests = this.requests.filter(s => s.status === 'pending')
    // New short searches share half the budget; the rest (and any leftover) goes to a bounded FIFO window,
    // which completes long searches one batch at a time instead of slicing all of them at once.
    let share = cap >> 1
    for (const s of this.requests) {
      if (share <= 0) break
      if (s.spent || s.estimate > SHORT_STEPS * this.minStep) continue
      const used = s.step(Math.min(share, FRESH_SLICE)); share -= used; cap -= used; this.visited += used
    }
    this.requests = this.requests.filter(s => s.status === 'pending')
    let guard = this.requests.length
    while (cap > 0 && this.requests.length && guard > 0) {
      this.cursor %= Math.min(WINDOW, this.requests.length)
      const s = this.requests[this.cursor]!, used = s.step(Math.min(cap, 128))
      cap -= used; this.visited += used
      if (s.status !== 'pending') { this.requests.splice(this.cursor, 1); guard = this.requests.length }
      else { this.cursor++; guard = used ? this.requests.length : guard - 1 }
    }
  }
  mixState(mix: (n: number) => void): void {
    mix(this.revision); mix(this.geometry); mix(this.flips); mix(this.cursor); mix(this.maxNodes); mix(this.revisions.length); for (const r of this.revisions) mix(r)
    mix(this.requests.length)
    for (const s of this.requests) { mix(s instanceof PathSearch ? 0 : s instanceof RouteSearch ? 1 : 2); s.mixState(mix) }
    mix(this.building.size); for (const [index, job] of this.building) { mix(index); job.mixState(mix) }
    this.landmarks.mixState(mix)
    const pre = this.pre; mix(pre.phase); mix(pre.ring); mix(pre.anchor); mix(pre.k); mix(pre.tile); mix(pre.built); mix(pre.idle); mix(this.prebuilt ? 1 : 0)
    mix(this.changed.length); for (const t of this.changed) mix(t); mix(this.warmed ? 1 : 0)
    mix(this.wetPending.length); for (const t of this.wetPending) { mix(t); mix(this.wetSince[t]!) }
  }
}

/** Compact typed records and indexed heap: only discovered support positions consume scratch. */
export class PathSearch {
  private readonly nav: NavigationSystem
  private readonly goals: readonly number[]
  private readonly blocked?: ReadonlySet<number>
  status: PathStatus = 'pending'
  path: number[] = []
  cost = 0
  /** Operations consumed so far; zero marks a search that has not had its first slice. */
  spent = 0
  /** Heuristic cost from the start; predicate-only searches look for nearby poses and count as short. */
  readonly estimate: number
  readonly seen = new Map<number, number>()
  private readonly ids = new Map<number, number>()
  private positions = new Uint32Array(256)
  private gs = new Uint32Array(256)
  private hs = new Uint32Array(256)
  private parents = new Int32Array(256)
  private heap = new Uint32Array(256)
  private indices = new Int32Array(256).fill(-1)
  private count = 0
  private size = 0
  private expanding = -1
  private direction = 0
  private reconstruct = -1
  private phase: 'search' | 'path' | 'reverse' | 'validate' = 'search'
  private reverseCursor = 0
  private validation: Iterator<[number, number]> | null = null
  private validationProgress = 0
  private validateRevision = 0
  private readonly goalSet: Set<number>
  private readonly allow?: (p: number) => boolean
  private readonly accept?: (p: number) => boolean
  private readonly region?: number
  private readonly reversible: boolean
  /** Whether confinement or a blocked pose (a body, which moves on) cut an edge: an exhausted search then proves nothing. */
  private cut = false
  /** Goal coordinates, x y z per goal, for the heuristic. */
  private readonly goalCoords: Int32Array
  /** The pose being expanded, decoded once for its four edges, and its tile. */
  private ex = 0
  private ey = 0
  private ez = 0
  private eti = 0
  /** Poses the policy rejected during navigation pass `rejectedPass`; the policy cannot change within a pass. */
  private readonly rejected = new Set<number>()
  private rejectedPass = -1
  constructor(nav: NavigationSystem, start: number, goals: readonly number[], blocked?: ReadonlySet<number>, options?: SearchOptions) {
    this.nav = nav; this.goals = goals; this.blocked = blocked; this.allow = options?.allowed; this.accept = options?.accept; this.region = options?.region; this.reversible = options?.reversible === true
    this.goalSet = new Set(goals)
    this.goalCoords = new Int32Array(goals.length * 3)
    goals.forEach((g, i) => this.goalCoords.set(nav.port.layout.voxelCoords(g), i * 3))
    this.estimate = this.h(start)
    if (!goals.length && !this.accept || !nav.stand(...nav.port.layout.voxelCoords(start))) { this.status = 'unreachable'; return }
    this.add(start, 0, -1)
  }
  get bytes(): number { return this.positions.byteLength * 6 }
  /** Whether a blocked set narrows the search: its failures are traffic, not terrain. */
  get restricted(): boolean { return this.blocked !== undefined && this.blocked.size > 0 }
  cancel(): void { this.status = 'cancelled' }
  result(): PathResult { return { status: this.status, path: this.path, cost: this.cost } }
  private permits(p: number): boolean { return this.allow ? this.allow(p) : this.nav.allowed(p) }
  /** `permits` for a pose not discovered yet, asked once per pose per pass. */
  private admits(p: number): boolean {
    if (this.rejectedPass !== this.nav.pass) { this.rejected.clear(); this.rejectedPass = this.nav.pass }
    if (this.rejected.has(p)) return false
    if (this.permits(p)) return true
    this.rejected.add(p); return false
  }
  private h(p: number): number {
    const G = this.goalCoords
    if (!G.length) return 0
    const plane = this.nav.plane, sx = this.nav.sx, y = (p / plane) | 0, r = p - y * plane, z = (r / sx) | 0, x = r - z * sx
    let h = 0xffffffff
    const step = this.nav.minStep, climb = this.nav.minClimb
    for (let i = 0; i < G.length; i += 3) h = Math.min(h, (Math.abs(x - G[i]!) + Math.abs(z - G[i + 2]!)) * step + Math.max(0, G[i + 1]! - y) * climb)
    return h
  }
  private less(a: number, b: number): boolean {
    const f = this.gs[a]! + this.hs[a]!, bf = this.gs[b]! + this.hs[b]!
    return f < bf || f === bf && (this.hs[a]! < this.hs[b]! || this.hs[a] === this.hs[b] && this.positions[a]! < this.positions[b]!)
  }
  private swap(a: number, b: number): void {
    const x = this.heap[a]!, y = this.heap[b]!; this.heap[a] = y; this.heap[b] = x; this.indices[x] = b; this.indices[y] = a
  }
  private up(i: number): void { while (i) { const p = (i - 1) >> 1; if (!this.less(this.heap[i]!, this.heap[p]!)) break; this.swap(i, p); i = p } }
  private add(p: number, g: number, parent: number, id = this.ids.get(p)): void {
    if (id === undefined) {
      if (this.count >= this.nav.maxNodes) { this.status = 'limited'; return }
      id = this.count++
      if (id === this.positions.length) for (const key of ['positions', 'gs', 'hs', 'parents', 'heap', 'indices'] as const) {
        const old = this[key], next = key === 'parents' || key === 'indices' ? new Int32Array(old.length * 2).fill(-1) : new Uint32Array(old.length * 2)
        next.set(old); this[key] = next as never
      }
      this.ids.set(p, id); this.positions[id] = p; this.hs[id] = this.h(p)
    } else if (this.gs[id]! <= g) return
    this.gs[id] = g; this.parents[id] = parent
    let i = this.indices[id]!
    if (i < 0) { i = this.size++; this.heap[i] = id; this.indices[id] = i }
    this.up(i)
  }
  private pop(): number {
    const id = this.heap[0]!; this.indices[id] = -1
    if (--this.size) {
      this.heap[0] = this.heap[this.size]!; this.indices[this.heap[0]!] = 0
      let i = 0
      while (i * 2 + 1 < this.size) {
        let c = i * 2 + 1
        if (c + 1 < this.size && this.less(this.heap[c + 1]!, this.heap[c]!)) c++
        if (!this.less(this.heap[c]!, this.heap[i]!)) break
        this.swap(c, i); i = c
      }
    }
    return id
  }
  step(cap: number): number {
    let used = 0
    while (used < cap && this.status === 'pending') {
      used++
      if (this.phase === 'validate') {
        this.validation ??= this.seen.entries()
        const next = this.validation.next()
        if (!next.done) { this.validationProgress++; if (this.nav.revisions[next.value[0]] !== next.value[1]) this.status = 'stale' }
        else if (this.validateRevision !== this.nav.revision) { this.validateRevision = this.nav.revision; this.validation = null; this.validationProgress = 0 }
        else this.status = this.path.length ? 'found' : this.cut ? 'limited' : 'unreachable'
      } else if (this.phase === 'path') {
        if (this.reconstruct < 0) this.phase = 'reverse'
        else { this.path.push(this.positions[this.reconstruct]!); this.reconstruct = this.parents[this.reconstruct]! }
      } else if (this.phase === 'reverse') {
        if (this.reverseCursor < Math.floor(this.path.length / 2)) {
          const i = this.reverseCursor++, j = this.path.length - 1 - i, p = this.path[i]!
          this.path[i] = this.path[j]!; this.path[j] = p
        } else { this.phase = 'validate'; this.validateRevision = this.nav.revision }
      } else if (this.expanding < 0) {
        if (!this.size) { this.phase = 'validate'; this.validateRevision = this.nav.revision; continue }
        this.expanding = this.pop(); this.direction = 0
        if (this.goalSet.has(this.positions[this.expanding]!) || this.accept?.(this.positions[this.expanding]!)) { this.cost = this.gs[this.expanding]!; this.reconstruct = this.expanding; this.phase = 'path' }
      } else {
        const nav = this.nav
        if (this.direction === 0) {
          const p = this.positions[this.expanding]!, y = (p / nav.plane) | 0, r = p - y * nav.plane, z = (r / nav.sx) | 0
          this.ex = r - z * nav.sx; this.ey = y; this.ez = z; this.eti = nav.tileOf(this.ex, y, z); nav.see(this.seen, this.eti)
        }
        const to = nav.edge(this.ex, this.ey, this.ez, this.eti, this.direction)
        if (to >= 0 && this.region !== undefined && nav.tileOfPose(to) !== this.region) this.cut = true
        else if (to >= 0 && this.blocked?.has(to)) this.cut = true
        else if (to >= 0 && (!this.reversible || nav.neighbor(to, this.direction ^ 1, this.seen) === this.positions[this.expanding]!)) {
          const ty = (to / nav.plane) | 0, g = this.gs[this.expanding]! + (this.direction >= 4 ? nav.ladderCost : nav.surfaces ? nav.stepCost(this.positions[this.expanding]!, to) : 4 + (ty > this.ey ? 2 : this.ey - ty) + (nav.wet(to) ? WADE_COST : 0)), id = this.ids.get(to)
          // Cheap tests first: a pose already reached as cheaply needs no policy call, and a rejection holds for the pass.
          if (id === undefined ? this.admits(to) : g < this.gs[id]! && this.permits(to)) this.add(to, g, this.expanding, id)
        }
        if (++this.direction === nav.dirs) this.expanding = -1
      }
    }
    this.spent += used
    return used
  }
  mixState(mix: (n: number) => void): void {
    const numbers = (values: readonly number[]) => { mix(values.length); for (const n of values) mix(n) }
    mix(['pending', 'found', 'unreachable', 'limited', 'stale', 'cancelled'].indexOf(this.status)); mix(this.validationProgress); mix(this.cost); mix(this.spent); mix(this.allow ? 1 : 0); mix(this.accept ? 1 : 0); mix(this.region ?? -1); mix(this.reversible ? 1 : 0); mix(this.cut ? 1 : 0)
    mix(['search', 'path', 'reverse', 'validate'].indexOf(this.phase)); mix(this.validateRevision); mix(this.reverseCursor)
    numbers(this.goals); numbers([...(this.blocked ?? [])].sort((a, b) => a - b))
    mix(this.count); mix(this.size); mix(this.expanding); mix(this.direction); mix(this.reconstruct)
    for (let i = 0; i < this.count; i++) { mix(this.positions[i]!); mix(this.gs[i]!); mix(this.hs[i]!); mix(this.parents[i]!); mix(this.indices[i]!) }
    for (let i = 0; i < this.size; i++) mix(this.heap[i]!)
    numbers(this.path); mix(this.seen.size)
    for (const [p, e] of this.seen) { mix(p); mix(e) }
  }
}
