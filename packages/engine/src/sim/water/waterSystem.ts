import { waterGroupOf, type BlockRegistry } from '../../blocks/registry.ts'
import type { ChunkStore } from '../../world/chunkStore.ts'
import type { Layout } from '../../world/layout.ts'
import { voxelId, voxelState } from '../../world/voxel.ts'
import type { WaterBuffers } from '../../world/waterBuffers.ts'
import { WaterColumns } from './columns.ts'
import { KIND, MIN_FLOW, SUB, TILE } from './constants.ts'
import { WaterCycle } from './cycle.ts'
import { WaterBodies } from './bodies.ts'
import { WaterEdges, type TileEdges } from './edges.ts'
import type { Packed } from '../../persist/pack.ts'
import { WaterMirror, mirrorQ, mirrorRun } from './mirror.ts'
import { WaterPublisher, type WaterTick } from './publish.ts'
import { rebuildSegments, waterKinds } from './rebuild.ts'
import { resegment, type Seg } from './resegment.ts'
import { UnderSegments } from './under.ts'

interface WaterJson { steps: number; sea: number; springs: number[]; cursor: number; stepNo: number; needsRebuild: boolean; lost?: number }
/** Saved lower segment: column, floor, ceil, depth, last, excess. Saved under edge: column a, floor a (−1: top), column b, floor b, flux. */
const UNDER_FIELDS = 6, EDGE_FIELDS = 5

/** A displaced volume spreads over columns that each take at most this much (1/16 block). */
const DISPLACE_SHARE = SUB / 16
/** The farthest a displaced volume looks for wet columns, in columns. */
const DISPLACE_RADIUS = 32

export interface WaterOptions {
  /** Awake tiles stepped per tick, in tile order, round robin; the rest wait (spec §6 safety net). Integer ≥ 1. Default 1024. */
  tileCap: number
  /** After every step, check Σ depth + sea against the running total and that no depth is negative; on failure log and rebuild. */
  debug: boolean
  /**
   * The depth (1/SUB block) a segment keeps before it sends any water on, and under which the mirror and the publisher draw
   * nothing. Integer, MIN_FLOW ≤ retain ≤ SUB. Default MIN_FLOW (1/64 block): films flow, and draw from SUB / 16 as before.
   */
  retain: number
  /**
   * Every `lossEvery` steps, each wet top column and free lower segment (not in a body) loses 1/SUB block into the `lost`
   * account, and one holding less than `retain` that did not gain since the previous pass loses all of it. Integer ≥ 0;
   * 0 (default) turns loss off.
   */
  lossEvery: number
}
export const DEFAULT_WATER_OPTIONS: WaterOptions = Object.freeze({ tileCap: 1024, debug: false, retain: MIN_FLOW, lossEvery: 0 })

/** What the water system needs from the Simulation. */
export interface WaterPort {
  readonly layout: Layout
  readonly registry: BlockRegistry
  readonly store: ChunkStore
  readonly buffers: WaterBuffers
  get(x: number, y: number, z: number): number
  /** A mirror write: under the chunk seqlock, with no remesh, no relight and no write hooks. */
  setQuiet(x: number, y: number, z: number, v: number): void
  log(message: string): void
}

/** Heightfield water in the world (spec §3–4): edits, the step, the mirror and rebuilds. Design notes: the 3c plan. */
export class WaterSystem {
  readonly o: WaterOptions
  /** The simulated liquid's block id (waterGroupOf); 0 when the registry has none, and then the system does nothing. */
  readonly water: number
  /** KIND per block id. */
  readonly kind: Uint8Array
  readonly cols: WaterColumns
  readonly cycle: WaterCycle
  readonly mirror: WaterMirror
  readonly under: UnderSegments
  readonly edges: WaterEdges
  readonly bodies: WaterBodies
  /** Set by a failed debug check or a physics error: the next step rebuilds every column from the voxels. */
  needsRebuild = false
  /** Σ depth + sea as physics must keep it; only edits and rebuilds move it. The debug check compares against it. */
  expected = 0
  /** The last flush's publish, or null when nothing changed: the tick message carries it to the main thread. */
  published: WaterTick | null = null
  private readonly publisher: WaterPublisher
  private steps = 0
  private readonly port: WaterPort
  private readonly layout: Layout
  private readonly height: number
  /** Columns whose top segment a wall displaced water from since the last spread: the first wall's cell, the surface before it and the volume displaced. Insertion order. */
  private readonly pending = new Map<number, { f0: number; s0: number; vol: number }>()
  private gen = 0
  private readonly stamp: Int32Array
  private readonly queue: number[] = []
  private readonly dist: number[] = []
  private readonly from: number[] = []
  private readonly fl: number[] = []
  private readonly sd: number[] = []
  private readonly seedC: number[] = []
  private readonly seedV: number[] = []
  private readonly seedS: number[] = []
  private readonly seedF: number[] = []
  private readonly done: number[] = []
  private readonly group: number[] = []
  private gTotal = 0
  private gEligible = 0
  private readonly seedOf: Int32Array
  /** Per top column: its depth after the last loss pass (empty while loss is off). */
  private readonly lossPrev: Int32Array
  private readonly targets: number[] = []
  private ex = 0
  private ez = 0
  /** KIND of cell y of the column being edited (ex, ez), as the store holds it after the write. */
  private readonly kindAt: (y: number) => number
  private readonly segScratch: Seg[] = []
  private readonly get: (x: number, y: number, z: number) => number
  private readonly set: (x: number, y: number, z: number, v: number) => void

  constructor(port: WaterPort, o: Partial<WaterOptions> = {}) {
    this.port = port
    this.layout = port.layout
    this.height = port.layout.size[1]
    this.o = { ...DEFAULT_WATER_OPTIONS, ...o }
    const cap = this.o.tileCap
    if (!Number.isInteger(cap) || cap < 1) throw new RangeError(`water option tileCap must be an integer ≥ 1, got ${cap}`)
    const retain = this.o.retain
    if (!Number.isInteger(retain) || retain < MIN_FLOW || retain > SUB) throw new RangeError(`water option retain must be an integer ${MIN_FLOW}–${SUB}, got ${retain}`)
    const every = this.o.lossEvery
    if (!Number.isInteger(every) || every < 0) throw new RangeError(`water option lossEvery must be an integer ≥ 0, got ${every}`)
    const reg = port.registry
    this.water = waterGroupOf(reg)
    if (this.water !== 0 && (reg.opaque[this.water] === 1 || reg.emits[this.water]! > 0)) {
      throw new Error(`block "${reg.name(this.water)}" is the simulated water: it must be transparent and emit no light (mirror writes do not relight)`)
    }
    this.kind = waterKinds(reg, this.water)
    const [sx, , sz] = port.layout.size
    this.cols = new WaterColumns(sx, sz, new Int16Array(port.buffers.floor))
    this.cols.floor.fill(0) // an empty world: every column dry on the world floor
    this.cols.minFlow = retain
    this.cols.shown = Math.max(SUB / 16, retain)
    this.under = new UnderSegments(sx * sz)
    this.edges = new WaterEdges(this.cols.tiles.count)
    this.cols.attach(this.under, this.edges, this.height)
    this.bodies = new WaterBodies(this.cols, this.under, this.edges)
    this.cycle = new WaterCycle(sx * sz)
    this.mirror = new WaterMirror(sx * sz)
    this.stamp = new Int32Array(sx * sz)
    this.lossPrev = new Int32Array(every > 0 ? sx * sz : 0)
    this.seedOf = new Int32Array(sx * sz)
    this.publisher = new WaterPublisher(port.buffers, retain)
    this.get = (x, y, z) => port.get(x, y, z)
    this.set = (x, y, z, v) => port.setQuiet(x, y, z, v)
    const sys = this
    this.kindAt = (y) => sys.kind[voxelId(port.get(sys.ex, y, sys.ez))]!
  }

  get enabled(): boolean { return this.water !== 0 }
  /** Authoritative immersion above feet in Q8, including cave segments. */
  depthAt(x: number, y: number, z: number): number {
    if (!this.enabled || !this.layout.inBounds(x, y, z)) return 0
    const c = x + z * this.cols.sx, U = this.under
    for (let i = U.first[c]!; i >= 0; i = U.next[i]!) if (y >= U.floor[i]! && y < U.ceil[i]!) return Math.max(0, U.surface(i) - y * SUB)
    return y >= this.cols.floor[c]! ? Math.max(0, this.cols.floor[c]! * SUB + this.cols.depth[c]! - y * SUB) : 0
  }
  /**
   * Removes up to `amount` (Q8) of the water above the bottom of cell (x, y, z), from the segment depthAt reads (a lower
   * segment holding y, else the top segment when y is at or above its floor), and returns what it removed: 0 when dry, out of
   * bounds, `amount` ≤ 0, or while a rebuild is pending (the voxels would bring the water back). The expected total drops by
   * the same amount; the tiles around wake and the mirror follows at the next flush. A body holding the segment drops and
   * regroups at the next step (as an edit's does), so a sealed body levels again too.
   */
  take(x: number, y: number, z: number, amount: number): number {
    if (!(amount > 0) || this.needsRebuild) return 0
    const got = Math.min(Math.floor(amount), this.depthAt(x, y, z))
    if (got <= 0) return 0
    const cols = this.cols, U = this.under, c = x + z * cols.sx
    let i = U.first[c]!
    while (i >= 0 && !(y >= U.floor[i]! && y < U.ceil[i]!)) i = U.next[i]!
    if (i >= 0) {
      if (U.body[i]! >= 0) this.bodies.dropBody(U.body[i]!)
      U.depth[i] = U.depth[i]! - got
    } else cols.depth[c] = cols.depth[c]! - got
    this.expected -= got
    cols.tiles.wakeAround(x, z)
    return got
  }
  get seaLevel(): number { return this.cycle.seaLevel }
  get sea(): number { return this.cycle.sea }
  /** Water the loss pass took out of the world (1/SUB block); 0 while loss is off. */
  get lost(): number { return this.cycle.lost }
  get stepCount(): number { return this.steps }

  /**
   * Sets the sea level (the generator's configure()) and finds the sea again at once, so the step never pins the old sea's
   * columns to the new level. The sea account follows the sea's water as in a region rebuild (plan decision 7).
   */
  setSeaLevel(v: number): void {
    const cy = this.cycle
    if (v === cy.seaLevel) return
    const before = cy.seaDepth(this.cols)
    cy.seaLevel = v
    if (this.water === 0) return
    cy.findSea(this.cols)
    cy.sea += cy.seaDepth(this.cols) - before
    this.expected = this.total()
  }

  /** Σ depth + sea + lost. */
  total(): number { return this.cols.total() + this.cycle.sea + this.cycle.lost }

  /** Column (x, z): floor, depth and surface. For tests and tools. */
  column(x: number, z: number): { floor: number; depth: number; surface: number } {
    const c = x + z * this.cols.sx
    return { floor: this.cols.floor[c]!, depth: this.cols.depth[c]!, surface: this.cols.surface(c) }
  }

  /** Column (x, z) bottom-up: its lower segments, then its top (ceil = the world's height, body −1). For tests and tools. */
  segments(x: number, z: number): { floor: number; ceil: number; depth: number; body: number }[] {
    const U = this.under, c = x + z * this.cols.sx, out: { floor: number; ceil: number; depth: number; body: number }[] = []
    for (let i = U.first[c]!; i >= 0; i = U.next[i]!) out.push({ floor: U.floor[i]!, ceil: U.ceil[i]!, depth: U.depth[i]!, body: U.body[i]! })
    out.push({ floor: this.cols.floor[c]!, ceil: this.height, depth: this.cols.depth[c]!, body: -1 })
    return out
  }

  /** Awake tiles, the wet segments in them, the bodies with a boundary in an awake tile, and wet segments past the draw layers. */
  stats(): { tiles: number; columns: number; bodies: number; layersHidden: number } {
    const T = this.cols.tiles
    return { tiles: T.awakeCount(), columns: this.cols.wetAwake(), bodies: this.bodies.activeCount(T.awake), layersHidden: this.publisher.hidden }
  }

  /** Every voxel write except the mirror's comes here, after the store took it (Simulation.applySet), paused or not. */
  onWrite(x: number, y: number, z: number, old: number, v: number): void {
    if (this.water === 0) return
    const reg = this.port.registry
    if (reg.source[voxelId(old)] === 1) this.cycle.springs.delete(this.layout.voxelIndex(x, y, z))
    if (reg.source[voxelId(v)] === 1) this.cycle.springs.add(this.layout.voxelIndex(x, y, z))
    const ok = this.kind[voxelId(old)]!, nk = this.kind[voxelId(v)]!
    if (ok === nk && nk !== KIND.WATER) return // wall for wall: nothing for water
    const cols = this.cols, U = this.under, c = x + z * cols.sx, T = cols.tiles
    // A body holding a segment of this column or of a neighbour (an edit only changes the edges to those columns: a new
    // opening into a body from beside it) regroups after the edit; its excess goes back to its members first.
    const sx = cols.sx, sz = cols.sz
    for (const nc of [c, x > 0 ? c - 1 : -1, x + 1 < sx ? c + 1 : -1, z > 0 ? c - sx : -1, z + 1 < sz ? c + sx : -1]) {
      if (nc < 0) continue
      for (let i = U.first[nc]!; i >= 0; i = U.next[i]!) if (U.body[i]! >= 0) this.bodies.dropBody(U.body[i]!)
    }
    const prior = this.segScratch
    prior.length = 0
    for (let i = U.first[c]!; i >= 0; i = U.next[i]!) prior.push({ floor: U.floor[i]!, ceil: U.ceil[i]!, depth: U.depth[i]! + U.excess[i]!, id: i })
    const f0 = cols.floor[c]!, d0 = cols.depth[c]!
    prior.push({ floor: f0, ceil: this.height, depth: d0, id: -2 })
    this.ex = x
    this.ez = z
    const r = resegment(prior, this.height, this.kindAt, y, ok, nk, nk === KIND.WATER ? (voxelState(v) & 7) + 1 : 0)
    const runs = r.runs, top = runs[runs.length - 1]!
    if (runs.length === prior.length && runs.every((q, k) => q.floor === prior[k]!.floor && q.ceil === prior[k]!.ceil && q.depth === prior[k]!.depth)) {
      // No segment changed, but a cell did (a stray water voxel, a removed block in the water): re-mirror the segment holding it.
      if (y >= f0) this.mirror.touch(c, y)
      for (let i = U.first[c]!; i >= 0; i = U.next[i]!) if (y >= U.floor[i]! && y < U.ceil[i]!) U.mirrorQ[i] = ~(U.ceil[i]! * 8)
      T.dirty[T.of(x, z)] = 1
      return
    }
    let before = 0, after = 0
    for (const s of prior) before += s.depth
    for (const q of runs) after += q.depth
    this.expected += after - before
    cols.floor[c] = top.floor
    cols.depth[c] = top.depth
    // The top's mirror rewrites from its floor: cells below a split belong to the lower run now (never cleared as 3c's push-up did).
    this.mirror.lo[c] = top.floor
    this.mirror.touch(c, Math.max(y, top.floor))
    const kept = new Set<number>(), chain: number[] = []
    for (let k = 0; k < runs.length - 1; k++) {
      const q = runs[k]!
      let i = q.id
      if (i >= 0) { U.floor[i] = q.floor; U.ceil[i] = q.ceil; kept.add(i) } else i = U.alloc(c, q.floor, q.ceil, 0)
      const cap = (q.ceil - q.floor) * SUB
      U.depth[i] = Math.min(q.depth, cap)
      U.excess[i] = Math.max(0, q.depth - cap)
      U.mirrorLo[i] = q.floor
      U.mirrorQ[i] = ~(q.ceil * 8)
      chain.push(i)
      if (q.depth >= cap) this.bodies.seed(i)
    }
    for (const s of prior) if (s.id >= 0 && !kept.has(s.id)) U.release(s.id)
    U.setChain(c, chain)
    T.dirty[T.of(x, z)] = 1
    if (this.wetAround(x, z)) T.wakeAround(x, z)
    this.edges.markColumn(x, z, cols)
    if (top.floor !== f0) this.floorMoved(x, z, c, f0, top.floor)
    for (const i of chain) this.springAt(x, U.floor[i]! - 1, z)
    // Water a wall displaced in the top segment spreads before the next step (3c's spreadDisplaced; plan decision 8).
    if (r.topDisplaced > 0) {
      const e = this.pending.get(c)
      if (e) e.vol += r.topDisplaced
      else this.pending.set(c, { f0: y, s0: f0 * SUB + d0, vol: r.topDisplaced })
    }
  }

  /**
   * Spreads the volume that walls placed since the last call displaced (see `pending`). Each source column displaced
   * `vol` (what resegment reported for the walls placed in its top segment since the last spread), at most its depth. Sources are
   * handled per connected group, in insertion order: a breadth-first search from the first source not yet handled goes through
   * wet neighbours that can exchange water (order -x +x -z +z) to at most DISPLACE_RADIUS columns from the nearest source; sources
   * it reaches join the group. The group's volume goes to the first ceil(volume / DISPLACE_SHARE) columns the search found (a
   * source among them while its floor is still under its old surface), in equal integer shares, the first `volume mod n` getting
   * one more. A group with no wet column besides its sources keeps its water on top of the walls, and water never crosses
   * between groups. If a huge edit finds fewer columns than wanted within the radius, their shares exceed 1/16 block and normal
   * flow levels it. Σ depth is unchanged. Runs before the step and before the mirror flush, so edits within a tick spread together.
   */
  private spreadDisplaced(): void {
    const pending = this.pending
    if (pending.size === 0) return
    const cols = this.cols, { floor, depth, sx, sz } = cols, T = cols.tiles
    const q = this.queue, dist = this.dist, from = this.from, fl = this.fl, sd = this.sd, stamp = this.stamp, seedOf = this.seedOf
    const sc = this.seedC, sv = this.seedV, ss = this.seedS, sf = this.seedF, done = this.done, group = this.group
    sc.length = 0
    sv.length = 0
    ss.length = 0
    sf.length = 0
    done.length = 0
    for (const [c, e] of pending) {
      const vol = Math.min(depth[c]!, e.vol)
      if (vol <= 0) continue
      seedOf[c] = sc.length + 1
      sc.push(c)
      sv.push(vol)
      ss.push(e.s0)
      sf.push(e.f0)
      done.push(0)
    }
    pending.clear()
    for (let first = 0; first < sc.length; first++) {
      if (done[first] === 1) continue
      const gen = ++this.gen
      q.length = 0
      dist.length = 0
      from.length = 0
      fl.length = 0
      sd.length = 0
      group.length = 0
      this.gTotal = 0
      this.gEligible = 0
      this.joinSeed(first, gen)
      for (let i = 0; i < q.length && this.gEligible < Math.ceil(this.gTotal / DISPLACE_SHARE); i++) {
        const d = dist[i]!
        if (d >= DISPLACE_RADIUS) continue
        const cc = q[i]!, cx = cc % sx, cz = (cc - cx) / sx, f = from[i]!, fc = fl[i]! * SUB
        for (let k = 0; k < 4; k++) {
          const nx = cx + (k === 0 ? -1 : k === 1 ? 1 : 0), nz = cz + (k === 2 ? -1 : k === 3 ? 1 : 0)
          if (nx < 0 || nz < 0 || nx >= sx || nz >= sz) continue
          const n = nx + nz * sx
          if (stamp[n] === gen || depth[n]! <= 0) continue
          const si = seedOf[n]! - 1
          // a source's floor before its wall is what the water saw
          if ((si >= 0 ? sf[si]! : floor[n]!) * SUB >= f) continue
          if (si >= 0 && done[si] === 0) {
            if (fc >= ss[si]!) continue
            this.joinSeed(si, gen) // a source is at distance 0: the radius counts from the nearest one
          } else {
            const sn = si >= 0 ? ss[si]! : cols.surface(n)
            if (fc >= sn) continue
            stamp[n] = gen
            q.push(n)
            dist.push(d + 1)
            from.push(sn)
            fl.push(floor[n]!)
            sd.push(0)
            this.gEligible++
          }
        }
      }
      if (q.length === group.length) continue // no wet column besides the sources: the water stays on top
      const total = this.gTotal, want = Math.ceil(total / DISPLACE_SHARE), targets = this.targets
      targets.length = 0
      for (let i = 0; i < q.length && targets.length < want; i++) {
        if (sd[i] === 0 || floor[q[i]!]! * SUB < from[i]!) targets.push(q[i]!)
      }
      const n = targets.length, share = Math.floor(total / n), extra = total - share * n
      for (const i of group) { depth[sc[i]!] = depth[sc[i]!]! - sv[i]!; T.dirty[T.of(sc[i]! % sx, Math.floor(sc[i]! / sx))] = 1 }
      for (let i = 0; i < n; i++) {
        const t = targets[i]!, tx = t % sx
        depth[t] = depth[t]! + share + (i < extra ? 1 : 0)
        T.wake(T.of(tx, (t - tx) / sx))
      }
    }
    for (const c of sc) seedOf[c] = 0
  }

  /** Adds source i to the current group of spreadDisplaced's search at distance 0. */
  private joinSeed(i: number, gen: number): void {
    const c = this.seedC[i]!
    this.done[i] = 1
    this.group.push(i)
    this.gTotal += this.seedV[i]!
    this.stamp[c] = gen
    this.queue.push(c)
    this.dist.push(0)
    this.from.push(this.seedS[i]!)
    this.fl.push(this.seedF[i]!)
    this.sd.push(1)
    if (this.cols.floor[c]! * SUB < this.seedS[i]!) this.gEligible++
  }

  /** One physics step (spec §3): springs, flow over the awake tiles, the sea. Not called while paused. */
  step(): void {
    if (this.water === 0) return
    if (this.needsRebuild) this.rebuild()
    this.spreadDisplaced()
    this.steps++
    const cy = this.cycle
    cy.runSprings(this.cols, this.under, this.layout, this.get, this.port.registry.source, (i) => this.bodies.seed(i))
    cy.sea += this.cols.step(this.o.tileCap, cy.seaLevel > 0 ? cy.mask : null, cy.seaLevel * SUB)
    const every = this.o.lossEvery
    if (every > 0 && this.steps % every === 0) this.lose()
    if (this.o.debug) {
      const bad = this.check()
      if (bad.length > 0) {
        this.port.log(`water: check failed (${bad.length}): ${bad.slice(0, 3).join('; ')}; rebuilding from the voxels`)
        this.needsRebuild = true
      }
    }
  }

  /** Rewrites the mirror of every dirty tile (every tick, paused or not); returns those tiles in index order and clears them. */
  flush(): number[] {
    this.published = null
    const out: number[] = []
    if (!this.needsRebuild) this.spreadDisplaced()
    // A pending rebuild means the columns are suspect: keep the voxels as the truth and the tiles dirty.
    if (this.water === 0 || this.needsRebuild) return out
    const cols = this.cols, T = cols.tiles, sx = cols.sx, floor = cols.floor, depth = cols.depth, mirror = this.mirror, U = this.under, shown = cols.shown
    for (let t = 0; t < T.count; t++) {
      if (T.dirty[t] !== 1) continue
      T.dirty[t] = 0
      out.push(t)
      const x0 = (t % T.tx) * TILE, z0 = Math.floor(t / T.tx) * TILE
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0, c = x0 + z * sx; x < x0 + TILE; x++, c++) {
        const f = floor[c]!, d = depth[c]!, q = mirror.q[c]!
        // Most moving surfaces still occupy the same eighth of a voxel. Avoid the full mirror call for those columns.
        if (q < 0 || mirror.lo[c] !== f || q !== mirrorQ(f, d, shown)) {
          mirror.flush(c, x, z, f, d, this.water, this.kind, this.height, this.get, this.set, shown)
        }
        for (let i = U.first[c]!; i >= 0; i = U.next[i]!) mirrorRun(U.mirrorLo, U.mirrorQ, i, x, z, U.floor[i]!, U.ceil[i]!, U.depth[i]!, this.water, this.kind, this.get, this.set, shown)
      }
    }
    this.published = this.publisher.publish(out, cols, { under: this.under, edges: this.edges, height: this.height })
    return out
  }

  /**
   * The next flush publishes every tile, with its layer records, as the first publish after generation does: for a water
   * view that starts over (a respawned water worker, 4a-r2 #2). `dirty` is publish bookkeeping, not world state (tiles.ts).
   */
  republishAll(): void { this.cols.tiles.dirty.fill(1) }

  /** The conservation identity and non-negative depths (spec §8). Whole world: for debug builds and tests. */
  check(): string[] {
    const out: string[] = []
    const d = this.cols.depth
    for (let c = 0; c < this.cols.n && out.length < 3; c++) if (d[c]! < 0) out.push(`column ${c} has depth ${d[c]}`)
    const U = this.under
    for (let c = 0; c < this.cols.n && out.length < 3; c++) for (let i = U.first[c]!; i >= 0; i = U.next[i]!) {
      if (U.depth[i]! < 0 || U.depth[i]! > U.cap(i)) out.push(`lower segment ${i} (column ${c}) has depth ${U.depth[i]} of ${U.cap(i)}`)
      if (U.excess[i]! < 0) out.push(`lower segment ${i} has excess ${U.excess[i]}`)
    }
    for (const b of this.bodies.list) if (b.excess < 0) out.push(`a body has excess ${b.excess}`)
    const t = this.total()
    if (this.cycle.lost < 0) out.push(`the loss account is ${this.cycle.lost}`)
    if (t !== this.expected) out.push(`Σ depth + sea + lost is ${t}, expected ${this.expected}`)
    return out
  }

  /** Drops all water state and rebuilds every segment from the voxels (generation, recovery). There is no static water left to remesh. */
  rebuild(): void {
    this.needsRebuild = false
    this.pending.clear()
    if (this.water === 0) return
    const [sx, , sz] = this.layout.size, cols = this.cols, cy = this.cycle
    cols.tiles.clear()
    cy.springs.clear()
    this.bodies.dropAll()
    rebuildSegments(this.port.store, this.kind, cols, this.under, this.mirror, 0, 0, sx, sz)
    this.edges.markAll()
    this.bodies.seedFull()
    this.findSprings(0, 0, sx, sz)
    cy.findSea(cols)
    cy.sea = cy.seaDepth(cols)
    this.wakeUnsettled(0, 0, sx, sz)
    cols.tiles.dirty.fill(1)
    this.expected = this.total()
  }

  /**
   * Rebuilds the columns of chunk columns `ccs` ([cx, cz] pairs) after a regeneration, paused or not (plan decision 10).
   * Only those chunk columns: one between two regenerated ones keeps its columns, flux and films. No chunk needs a remesh:
   * water is never meshed (3d).
   */
  rebuildChunkColumns(ccs: readonly (readonly [number, number])[]): void {
    if (this.water === 0 || ccs.length === 0) return
    this.spreadDisplaced()
    const cols = this.cols, cy = this.cycle, T = cols.tiles, L = this.layout
    const regenerated = new Set(ccs.map(([cx, cz]) => cx + cz * L.cx))
    for (const s of [...cy.springs]) {
      const [x, , z] = L.voxelCoords(s)
      if (regenerated.has((x >> 5) + (z >> 5) * L.cx)) cy.springs.delete(s)
    }
    const seaBefore = cy.seaDepth(cols)
    this.bodies.dropAll()
    for (const [cx, cz] of ccs) {
      rebuildSegments(this.port.store, this.kind, cols, this.under, this.mirror, cx * 32, cz * 32, cx * 32 + 32, cz * 32 + 32)
      this.findSprings(cx * 32, cz * 32, cx * 32 + 32, cz * 32 + 32)
      for (let z = cz * 32; z < cz * 32 + 32; z++) for (let x = cx * 32; x < cx * 32 + 32; x++) this.edges.markColumn(x, z, cols)
    }
    this.bodies.seedFull()
    // The sea account follows the sea's water (plan decision 7): a column that joins the sea brings its depth, one that
    // leaves takes the depth it held before the rebuild, and a regenerated sea column adds what its depth changed by.
    cy.findSea(cols)
    cy.sea += cy.seaDepth(cols) - seaBefore
    for (const [cx, cz] of ccs) {
      const x0 = cx * 32, z0 = cz * 32
      for (let tz = z0 / TILE; tz < (z0 + 32) / TILE; tz++) for (let tx = x0 / TILE; tx < (x0 + 32) / TILE; tx++) T.dirty[tx + tz * T.tx] = 1
      this.wakeUnsettled(Math.max(0, x0 - 1), Math.max(0, z0 - 1), Math.min(cols.sx, x0 + 33), Math.min(cols.sz, z0 + 33))
    }
    this.expected = this.total()
  }

  /**
   * What a rebuild from the voxels cannot recover (plan deviation 4). Lower segments and under edges are named by column and
   * floor (ceil checked), never by pool index; a body's excess goes to its first member, as dropBody does.
   */
  snapshot(): Packed {
    const cols = this.cols, U = this.under, n = cols.n
    const bodyExcess = new Map<number, number>()
    for (const b of this.bodies.list) if (b.members.length) bodyExcess.set(b.members[0]!, b.excess)
    const under: number[] = [], lossUnder: number[] = []
    for (let c = 0; c < n; c++) for (let i = U.first[c]!; i >= 0; i = U.next[i]!) {
      under.push(c, U.floor[i]!, U.ceil[i]!, U.depth[i]!, U.last[i]!, U.excess[i]! + (bodyExcess.get(i) ?? 0))
      lossUnder.push(U.lossPrev[i]!)
    }
    const end = (ref: number): [number, number] => ref < n ? [ref, -1] : [U.col[ref - n]!, U.floor[ref - n]!]
    const edges: number[] = []
    for (const E of this.edges.tiles) if (E) for (let e = 0; e < E.count; e++) if (E.flux[e] !== 0) edges.push(...end(E.a[e]!), ...end(E.b[e]!), E.flux[e]!)
    const s = cols.state()
    const json: WaterJson = { steps: this.steps, sea: this.cycle.sea, springs: [...this.cycle.springs], cursor: s.cursor, stepNo: s.stepNo, needsRebuild: this.needsRebuild }
    const loss = this.o.lossEvery > 0
    // Loss state only while loss is on: a save without it is byte-identical to one from before the option.
    if (loss || this.cycle.lost !== 0) json.lost = this.cycle.lost
    return { json, arrays: {
      depth: s.depth.slice(), flux: s.flux.slice(), last: s.last.slice(),
      awake: cols.tiles.awake.slice(), quiet: cols.tiles.quiet.slice(),
      under: Int32Array.from(under), edges: Int32Array.from(edges),
      ...(loss && { lossPrev: this.lossPrev.slice(), lossUnder: Int32Array.from(lossUnder) }),
    } }
  }

  /** Over a fresh rebuild() of the same voxels: puts back the exact water (plan deviation 4). */
  restore(p: Packed): void {
    if (this.water === 0) return
    const j = p.json as WaterJson, a = p.arrays, cols = this.cols, U = this.under
    if (j.needsRebuild) { this.needsRebuild = true; return }
    cols.restoreState(a.depth as Int32Array, a.flux as Int32Array, a.last as Int32Array, j.cursor, j.stepNo)
    const u = a.under as Int32Array, lossUnder = a.lossUnder as Int32Array | undefined
    for (let k = 0; k < u.length; k += UNDER_FIELDS) {
      const i = this.lowerAt(u[k]!, u[k + 1]!)
      if (i < 0 || U.ceil[i] !== u[k + 2]) { this.port.log(`water restore: column ${u[k]} has no lower segment ${u[k + 1]}–${u[k + 2]}; its water is dropped`); continue }
      U.depth[i] = u[k + 3]!; U.last[i] = u[k + 4]!; U.excess[i] = u[k + 5]!
      if (lossUnder) U.lossPrev[i] = lossUnder[k / UNDER_FIELDS]!
    }
    const lossPrev = a.lossPrev as Int32Array | undefined
    if (lossPrev && lossPrev.length === this.lossPrev.length) this.lossPrev.set(lossPrev)
    this.bodies.dropAll()
    this.bodies.seedFull()
    this.edges.ensure(cols, U, this.height)
    const byEnds = new Map<number, { E: TileEdges; e: number }>()
    for (const E of this.edges.tiles) if (E) for (let e = 0; e < E.count; e++) byEnds.set(E.a[e]! * 4294967296 + E.b[e]!, { E, e })
    const ed = a.edges as Int32Array
    for (let k = 0; k < ed.length; k += EDGE_FIELDS) {
      const ra = this.refAt(ed[k]!, ed[k + 1]!), rb = this.refAt(ed[k + 2]!, ed[k + 3]!)
      const hit = ra < 0 || rb < 0 ? undefined : byEnds.get(ra * 4294967296 + rb)
      if (hit) hit.E.flux[hit.e] = ed[k + 4]!
    }
    const cy = this.cycle
    cy.findSea(cols)
    cy.sea = j.sea
    cy.lost = j.lost ?? 0
    cy.springs.clear()
    for (const s of j.springs) cy.springs.add(s)
    cols.tiles.awake.set(a.awake as Uint8Array)
    cols.tiles.quiet.set(a.quiet as Uint8Array)
    cols.tiles.dirty.fill(1)
    this.steps = j.steps
    this.needsRebuild = false
    this.expected = this.total()
  }

  private lowerAt(c: number, floor: number): number {
    for (let i = this.under.first[c]!; i >= 0; i = this.under.next[i]!) if (this.under.floor[i] === floor) return i
    return -1
  }

  /** A segment ref from its column and floor (−1: the top segment); −1 when the column has no such segment. */
  private refAt(c: number, floor: number): number {
    if (floor < 0) return c
    const i = this.lowerAt(c, floor)
    return i < 0 ? -1 : this.under.n + i
  }

  mixState(mix: (v: number) => void): void {
    mix(this.steps)
    mix(this.needsRebuild ? 1 : 0)
    this.cols.mixState(mix)
    this.cycle.mixState(mix)
    this.mirror.mixState(mix)
    if (this.o.lossEvery > 0) { // only with loss on, so worlds without it hash as before
      mix(this.cycle.lost)
      const U = this.under, prev = this.lossPrev
      for (let c = 0; c < prev.length; c++) {
        mix(prev[c]!)
        for (let i = U.first[c]!; i >= 0; i = U.next[i]!) mix(U.lossPrev[i]!)
      }
    }
  }

  /**
   * The loss pass (WaterOptions.lossEvery; plan D3–D5): every wet top column off the sea and every wet lower segment outside
   * a body loses 1/SUB block, or all of it when it holds less than `retain` and did not gain since the previous pass; a top
   * column only when it is also still (no flux on its four edges: spec §4.1) and no neighbour holds `retain` or more. So a
   * front being filled, sloshing water and a pond's rim are never cut: wiping a rim would let the pond spill into the gap
   * and be wiped again at every pass, a sink far above the per-column loss. The water goes to the `lost` account, so the conservation identity holds. Touched tiles
   * republish; a tile wakes only where a segment went dry, so a settled pond keeps sleeping.
   */
  private lose(): void {
    const cols = this.cols, depth = cols.depth, flux = cols.flux, sx = cols.sx, n = cols.n, T = cols.tiles, U = this.under
    const mask = this.cycle.mask, prev = this.lossPrev, retain = this.o.retain
    let lost = 0
    for (let c = 0; c < n; c++) {
      const d = depth[c]!
      let touched = false, dried = false
      if (d > 0 && mask[c] === 0) {
        let take = 1
        if (d < retain && d <= prev[c]!) {
          const x = c % sx
          const still = flux[2 * c] === 0 && flux[2 * c + 1] === 0 && (x === 0 || flux[2 * c - 2] === 0) && (c < sx || flux[2 * (c - sx) + 1] === 0)
          const alone = (x === 0 || depth[c - 1]! < retain) && (x + 1 === sx || depth[c + 1]! < retain) &&
            (c < sx || depth[c - sx]! < retain) && (c + sx >= n || depth[c + sx]! < retain)
          if (still && alone) take = d
        }
        depth[c] = d - take
        lost += take
        touched = true
        dried = take === d
      }
      prev[c] = depth[c]!
      for (let i = U.first[c]!; i >= 0; i = U.next[i]!) {
        const ud = U.depth[i]!
        if (ud > 0 && U.body[i]! < 0) {
          const take = ud < retain && ud <= U.lossPrev[i]! ? ud : 1
          U.depth[i] = ud - take
          lost += take
          touched = true
          if (take === ud) dried = true
        }
        U.lossPrev[i] = U.depth[i]!
      }
      if (!touched) continue
      const x = c % sx, z = (c - x) / sx
      T.dirty[T.of(x, z)] = 1
      if (dried) T.wakeAround(x, z)
    }
    this.cycle.lost += lost
  }

  /** Whether a segment of column (x, z) or of one of its four neighbours holds water: only then can an edit there move any. */
  private wetAround(x: number, z: number): boolean {
    const { sx, sz } = this.cols
    const wet = (c: number) => {
      if (this.cols.depth[c]! > 0) return true
      for (let i = this.under.first[c]!; i >= 0; i = this.under.next[i]!) if (this.under.depth[i]! > 0) return true
      return false
    }
    const c = x + z * sx
    return wet(c) || (x > 0 && wet(c - 1)) || (x + 1 < sx && wet(c + 1)) || (z > 0 && wet(c - sx)) || (z + 1 < sz && wet(c + sx))
  }

  private floorMoved(x: number, z: number, c: number, from: number, to: number): void {
    if (to >= this.cycle.seaLevel) this.cycle.mask[c] = 0
    this.springAt(x, to - 1, z)
  }

  /** Remembers a spring at (x, y, z) if there is one (a column's floor block). */
  private springAt(x: number, y: number, z: number): void {
    if (y < 0 || y >= this.height) return
    if (this.port.registry.source[voxelId(this.port.get(x, y, z))] === 1) this.cycle.springs.add(this.layout.voxelIndex(x, y, z))
  }

  private findSprings(x0: number, z0: number, x1: number, z1: number): void {
    const { floor, sx } = this.cols, U = this.under
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      const c = x + z * sx
      this.springAt(x, floor[c]! - 1, z)
      for (let i = U.first[c]!; i >= 0; i = U.next[i]!) this.springAt(x, U.floor[i]! - 1, z)
    }
  }

  /**
   * Wakes the tile of every wet, non-sea column in the range that stands above a neighbour it can flow to, and of every
   * column with a lower segment holding at least minFlow (the retain option).
   */
  private wakeUnsettled(x0: number, z0: number, x1: number, z1: number): void {
    const { floor, depth, sx, sz, tiles, minFlow } = this.cols, mask = this.cycle.mask, U = this.under
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      const c = x + z * sx, d = depth[c]!
      let low = false
      for (let i = U.first[c]!; i >= 0 && !low; i = U.next[i]!) low = U.depth[i]! >= minFlow
      if (low) { tiles.wake(tiles.of(x, z)); continue }
      if (d < minFlow || mask[c] === 1) continue
      const s = floor[c]! * SUB + d
      if ((x > 0 && s > this.cols.surface(c - 1)) || (x + 1 < sx && s > this.cols.surface(c + 1)) ||
        (z > 0 && s > this.cols.surface(c - sx)) || (z + 1 < sz && s > this.cols.surface(c + sx))) tiles.wake(tiles.of(x, z))
    }
  }
}
