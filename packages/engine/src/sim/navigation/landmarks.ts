import type { NavigationSystem } from './navigation.ts'
import { GroupField } from './groupField.ts'
import type { RelaxedRecords } from './routeSearch.ts'
import { UNREACHED, slotOf, splitKey, type Region } from './regions.ts'

/** No cost known: the exit or tile does not reach the landmark, or was not read. */
export const NO_COST = 0x7fffffff

/**
 * Finished landmark tables (ALT): for landmark k (a tile, all its region poses), the cost from each exit's `from` pose
 * to it, by its best way out of the region, over the records the computation read, and per tile the cheapest of them. They are exact for those records, so
 * the bounds below are admissible and consistent there; `geometry` is the solid-geometry count they were computed at.
 */
export class LandmarkTables {
  readonly geometry: number
  readonly tiles: readonly number[]
  /** lo[k * tileCount + t]: the cheapest exit of tile t to landmark k (0 on the landmark's own tile), else NO_COST. */
  readonly lo: Int32Array
  /** Per tile: the record epoch every landmark read (else no entry), and the cost from exit e's `from` pose to landmark k at k * exits + e. */
  readonly exits: ReadonlyMap<number, { epoch: number; d: Int32Array }>
  private readonly tileCount: number
  constructor(geometry: number, tiles: readonly number[], tileCount: number, lo: Int32Array, exits: ReadonlyMap<number, { epoch: number; d: Int32Array }>) {
    this.geometry = geometry; this.tiles = tiles; this.tileCount = tileCount; this.lo = lo; this.exits = exits
  }
  get count(): number { return this.tiles.length }
  /** Lower bound of the cost from any pose of `tile` to landmark k (a pose leaves its tile through an exit). */
  low(k: number, tile: number): number { return this.lo[k * this.tileCount + tile]! }
  /** Cost from the `from` pose of exit e of `region` to landmark k when the tables read this very record, else NO_COST. */
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

/** A tile's exit costs while a landmark job fills them: the normal record they price, which the refining pass reads. */
interface Pending { epoch: number; d: Int32Array; record: Region }

/**
 * Computes landmark tables in the background, one landmark at a time, as an exhaustive reverse search over region exits
 * (a group field with no starts), on budget the prebuild hands over. The searches read the relaxed graph, where poses
 * on falling blocks are standable: sand that gets wet adds poses and can only make real ways cheaper than the regions
 * said, never cheaper than the relaxed graph, so the tables stay a lower bound through those changes and are kept. A
 * solid edit (the `geometry` count) retires them at once and starts them over. Exact exit costs are kept only for
 * tiles read from the shared store (their record has nothing to relax); a relaxed tile keeps its tile bound only.
 */
export class Landmarks {
  private readonly nav: NavigationSystem
  private ready: LandmarkTables | null = null
  /** A job whose search ended limited: no tables until the geometry changes (its costs could be too high). */
  private failed = -1
  private job: {
    geometry: number; tiles: number[]; k: number; field: GroupField | null; lo: Int32Array; exits: Map<number, Pending>
    relaxed: RelaxedRecords
    /** The finished field's costs, read in place, and how many were read. */
    harvest: IterableIterator<[number, number]> | null; at: number; best: [number, Pending][] | null
    /** Operations owed by a region refined in one piece, paid before anything else. */
    debt: number
  } | null = null
  constructor(nav: NavigationSystem) { this.nav = nav }
  /** The tables for new queries: current ones only, so no edit since makes their bounds too high. */
  current(): LandmarkTables | null { return this.ready && this.ready.geometry === this.nav.geometry ? this.ready : null }
  /** Nothing left to compute for the current geometry: tables are current, or the last job ended limited. */
  settled(): boolean { return this.current() !== null || this.failed === this.nav.geometry }
  reset(): void { this.ready = null; this.job = null; this.failed = -1 }
  /** Bytes held: the tables, and a job's partial tables and relaxed records. */
  get bytes(): number {
    let n = 0
    const tables = (lo: Int32Array, exits: Iterable<{ d: Int32Array }>) => { n += lo.byteLength; for (const t of exits) n += t.d.byteLength + 16 }
    if (this.ready) tables(this.ready.lo, this.ready.exits.values())
    if (this.job) { tables(this.job.lo, this.job.exits.values()); for (const r of this.job.relaxed.records.values()) n += r.bytes }
    return n
  }
  /** Advances the computation by at most `cap` operations; returns those used. */
  step(cap: number): number {
    let used = 0
    while (used < cap && !this.settled()) {
      const job = this.job
      if (!job || job.geometry !== this.nav.geometry) { this.start(); used++; if (!this.job!.tiles.length) { this.finish(); break }; continue }
      if (job.debt) { const pay = Math.min(job.debt, cap - used); job.debt -= pay; used += pay; continue }
      if (job.harvest) { used += this.harvest(cap - used); continue }
      if (job.best) { if (job.at === job.best.length) this.finish(); else used += this.best(cap - used); continue }
      if (!job.field) {
        const tile = job.tiles[job.k]!, r = this.nav.regions.get(tile)
        // The landmark's record went (evicted, or its tile changed): build it again on this budget.
        if (!r) { const { used: spent } = this.nav.regionNow(tile, cap - used); used += Math.max(1, spent); continue }
        job.field = new GroupField(this.nav, this.nav.regions, [...r.poses], [], 1 << 22, 1, { landmarks: null, exhaust: true, relaxed: job.relaxed })
        used++
        continue
      }
      used += job.field.step(cap - used)
      if (job.field.status === 'pending') continue
      // A search cut short leaves tentative costs, possibly too high for a lower bound: no tables for this geometry.
      if (job.field.status !== 'found') { this.failed = job.geometry; this.job = null; break }
      job.harvest = job.field.costs(); job.at = 0
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
    this.job = { geometry: nav.geometry, tiles, k: 0, field: null, lo: new Int32Array(tiles.length * count).fill(NO_COST), exits: new Map(), relaxed: { records: new Map(), building: new Map() }, harvest: null, at: 0, best: null, debt: 0 }
    tiles.forEach((t, k) => { this.job!.lo[k * count + t] = 0 })
  }
  /** Reads one finished landmark's exit costs into the tables, one operation per exit. */
  private harvest(cap: number): number {
    const job = this.job!, field = job.field!, k = job.k, L = job.tiles.length, count = this.nav.revisions.length
    let used = 0
    while (used < cap) {
      const next = job.harvest!.next()
      if (next.done) break
      const [key, d] = next.value, [index, e] = splitKey(key), r = field.region(index)!
      used++; job.at++
      const at = k * count + index
      if (d < job.lo[at]!) job.lo[at] = d
      // A relaxed record's exits are not the ones searches read: its tile bound is all it gives.
      if (r.relaxed) continue
      let t = job.exits.get(index)
      if (!t) { t = { epoch: r.epoch, d: new Int32Array(L * r.exits.length).fill(NO_COST), record: r }; job.exits.set(index, t) }
      // Landmarks that read different records of a tile leave it no exact costs (its tile bound still holds).
      if (t.record !== r) t.epoch = -1
      else t.d[k * r.exits.length + e] = d
    }
    if (used < cap) {
      job.harvest = null; job.field = null; job.k++
      if (job.k === job.tiles.length) { for (const [index, t] of job.exits) if (t.epoch < 0) job.exits.delete(index); job.best = [...job.exits]; job.at = 0 }
    }
    return used
  }
  /**
   * An exit's own cost runs through its crossing, which may lead away from the landmark: each becomes the cost from
   * its `from` pose by the best exit of the region (the in-region cost to that exit plus its cost), one operation per pair.
   */
  private best(cap: number): number {
    const job = this.job!, list = job.best!, L = job.tiles.length, layout = this.nav.port.layout
    let used = 0
    while (used < cap && job.at < list.length) {
      const [, t] = list[job.at++]!, r = t.record, E = r.exits.length, P = r.poses.length, own = t.d.slice()
      for (let e = 0; e < E; e++) {
        const slot = slotOf(r, r.exits[e]!.from, layout)
        for (let k = 0; k < L; k++) for (let x = 0; x < E; x++) {
          const c = r.fields[x * P + slot]!, d = own[k * E + x]!
          if (c !== UNREACHED && d !== NO_COST && c + d < t.d[k * E + e]!) t.d[k * E + e] = c + d
        }
      }
      const cost = 1 + E * E * L, pay = Math.min(cost, cap - used)
      used += pay; job.debt += cost - pay
    }
    if (job.at === list.length && !job.debt) this.finish()
    return used
  }
  /** Keeps the tables without the records they were read from (nor the relaxed ones), so the store's cap governs those. */
  private finish(): void {
    const job = this.job!, exits = new Map<number, { epoch: number; d: Int32Array }>()
    for (const [index, t] of job.exits) exits.set(index, { epoch: t.epoch, d: t.d })
    this.ready = new LandmarkTables(job.geometry, job.tiles, this.nav.revisions.length, job.lo, exits)
    this.job = null
  }
  mixState(mix: (n: number) => void): void {
    mix(this.ready ? this.ready.geometry : -1); mix(this.ready?.count ?? 0); mix(this.failed)
    const job = this.job
    mix(job ? 1 : 0)
    if (!job) return
    mix(job.geometry); mix(job.tiles.length); for (const t of job.tiles) mix(t); mix(job.k); mix(job.at); mix(job.harvest ? 1 : 0); mix(job.best?.length ?? -1); mix(job.debt)
    mix(job.relaxed.records.size); mix(job.relaxed.building.size)
    mix(job.field ? 1 : 0); job.field?.mixState(mix)
  }
}
