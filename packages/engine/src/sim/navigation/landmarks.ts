import type { NavigationSystem } from './navigation.ts'
import { GroupField } from './groupField.ts'
import { UNREACHED, splitKey, type Region } from './regions.ts'

/** No cost known: the exit or tile does not reach the landmark, or was not read. */
export const NO_COST = 0x7fffffff

/**
 * Finished landmark tables (ALT): for landmark k (a tile, all its region poses), the cost from each exit to it over the
 * region records the computation read, and per tile the cheapest of its exits. They are exact for those records, so
 * the bounds below are admissible and consistent there; `geometry` is the solid-geometry count they were computed at.
 */
export class LandmarkTables {
  readonly geometry: number
  readonly tiles: readonly number[]
  /** lo[k * tileCount + t]: the cheapest exit of tile t to landmark k (0 on the landmark's own tile), else NO_COST. */
  readonly lo: Int32Array
  /** Per tile: the record epoch every landmark read (else no entry), and the cost of each exit e to landmark k at k * exits + e. */
  readonly exits: ReadonlyMap<number, { epoch: number; d: Int32Array }>
  private readonly tileCount: number
  constructor(geometry: number, tiles: readonly number[], tileCount: number, lo: Int32Array, exits: ReadonlyMap<number, { epoch: number; d: Int32Array }>) {
    this.geometry = geometry; this.tiles = tiles; this.tileCount = tileCount; this.lo = lo; this.exits = exits
  }
  get count(): number { return this.tiles.length }
  /** Lower bound of the cost from any pose of `tile` to landmark k (a pose leaves its tile through an exit). */
  low(k: number, tile: number): number { return this.lo[k * this.tileCount + tile]! }
  /** Cost from exit e of `region` to landmark k when the tables read this very record, else NO_COST. */
  exit(k: number, region: Region, e: number): number {
    const t = this.exits.get(region.index)
    return t && t.epoch === region.epoch ? t.d[k * region.exits.length + e]! : NO_COST
  }
  /**
   * Upper bound of the cost from the pose at `slot` of `region` to landmark k: its cheapest way out through an exit whose
   * cost the tables know; 0 on the landmark's tile, NO_COST when none is known.
   */
  high(k: number, region: Region, slot: number): number {
    if (region.index === this.tiles[k]) return 0
    const P = region.poses.length
    let best = NO_COST
    if (slot < 0) return best
    for (let e = 0; e < region.exits.length; e++) {
      const c = region.fields[e * P + slot]!, d = this.exit(k, region, e)
      if (c !== UNREACHED && d !== NO_COST) best = Math.min(best, c + d)
    }
    return best
  }
}

/** Landmark positions, as fractions of the world's columns: its corners and edge midpoints. */
const SPOTS: readonly (readonly [number, number])[] = [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]]

/**
 * Computes landmark tables in the background, one landmark at a time, as an exhaustive reverse search over region exits
 * (a group field with no starts), on budget the prebuild hands over. A solid edit (the `geometry` count) retires the
 * current tables at once, so no new query reads costs an opened wall would make too high, and starts them over. A
 * change of the falls rule alone (sand that gets wet or dries) keeps them: it adds or drops single poses at water's
 * edge, and the next computation picks it up.
 */
export class Landmarks {
  private readonly nav: NavigationSystem
  private ready: LandmarkTables | null = null
  private job: { geometry: number; tiles: number[]; k: number; field: GroupField | null; lo: Int32Array; exits: Map<number, { epoch: number; d: Int32Array }>; harvest: [number, number][] | null; at: number } | null = null
  constructor(nav: NavigationSystem) { this.nav = nav }
  /** The tables for new queries: current ones only, so no edit since makes their bounds too high. */
  current(): LandmarkTables | null { return this.ready && this.ready.geometry === this.nav.geometry ? this.ready : null }
  reset(): void { this.ready = null; this.job = null }
  /** Advances the computation by at most `cap` operations; returns those used. */
  step(cap: number): number {
    let used = 0
    while (used < cap && !this.current()) {
      const job = this.job
      if (!job || job.geometry !== this.nav.geometry) { this.start(); used++; if (!this.job!.tiles.length) { this.finish(); break }; continue }
      if (job.harvest) { used += this.harvest(cap - used); continue }
      if (!job.field) {
        const tile = job.tiles[job.k]!, r = this.nav.regions.get(tile)
        // The landmark's record went (evicted, or its tile changed): build it again on this budget.
        if (!r) { const { used: spent } = this.nav.regionNow(tile, cap - used); used += Math.max(1, spent); continue }
        job.field = new GroupField(this.nav, this.nav.regions, [...r.poses], [], 1 << 22, 1, { landmarks: null, exhaust: true })
        used++
        continue
      }
      used += job.field.step(cap - used)
      if (job.field.status === 'pending') continue
      job.harvest = [...job.field.costs()]; job.at = 0
    }
    return used
  }
  /** Chooses the landmark tiles: at each spot, the lowest tile whose record has poses. */
  private start(): void {
    const nav = this.nav, [sx, sy, sz] = nav.port.layout.size, tx = sx >> 4, tz = sz >> 4, ty = sy >> 4, tiles: number[] = []
    for (const [fx, fz] of SPOTS) {
      const x = Math.min(tx - 1, fx * (tx >> 1)), z = Math.min(tz - 1, fz * (tz >> 1))
      for (let y = 0; y < ty; y++) {
        const t = x + z * tx + y * tx * tz, r = nav.regions.get(t)
        if (r?.poses.length) { if (!tiles.includes(t)) tiles.push(t); break }
      }
    }
    const count = tx * tz * ty
    this.job = { geometry: nav.geometry, tiles, k: 0, field: null, lo: new Int32Array(tiles.length * count).fill(NO_COST), exits: new Map(), harvest: null, at: 0 }
    tiles.forEach((t, k) => { this.job!.lo[k * count + t] = 0 })
  }
  /** Copies one finished landmark's exit costs into the tables, one operation per exit. */
  private harvest(cap: number): number {
    const job = this.job!, field = job.field!, list = job.harvest!, k = job.k, L = job.tiles.length, count = this.nav.revisions.length
    let used = 0
    while (used < cap && job.at < list.length) {
      const [key, d] = list[job.at++]!, [index, e] = splitKey(key), r = field.region(index)!
      used++
      let t = job.exits.get(index)
      if (!t) { t = { epoch: r.epoch, d: new Int32Array(L * r.exits.length).fill(NO_COST) }; job.exits.set(index, t) }
      // Landmarks that read different records of a tile leave it no exact costs (its tile bound still holds).
      if (t.epoch !== r.epoch || t.d.length !== L * r.exits.length) t.epoch = -1
      else t.d[k * r.exits.length + e] = d
      const at = k * count + index
      if (d < job.lo[at]!) job.lo[at] = d
    }
    if (job.at === list.length) { job.harvest = null; job.field = null; job.k++; if (job.k === job.tiles.length) this.finish() }
    return used
  }
  private finish(): void {
    const job = this.job!
    for (const [index, t] of job.exits) if (t.epoch < 0) job.exits.delete(index)
    this.ready = new LandmarkTables(job.geometry, job.tiles, this.nav.revisions.length, job.lo, job.exits)
    this.job = null
  }
  mixState(mix: (n: number) => void): void {
    mix(this.ready ? this.ready.geometry : -1); mix(this.ready?.count ?? 0)
    const job = this.job
    mix(job ? 1 : 0)
    if (!job) return
    mix(job.geometry); mix(job.tiles.length); for (const t of job.tiles) mix(t); mix(job.k); mix(job.at); mix(job.harvest?.length ?? -1)
    mix(job.field ? 1 : 0); job.field?.mixState(mix)
  }
}
