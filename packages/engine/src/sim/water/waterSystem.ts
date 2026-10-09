import { waterGroupOf, type BlockRegistry } from '../../blocks/registry.ts'
import type { ChunkStore } from '../../world/chunkStore.ts'
import type { Layout } from '../../world/layout.ts'
import { voxelId, voxelState } from '../../world/voxel.ts'
import type { WaterBuffers } from '../../world/waterBuffers.ts'
import { WaterColumns } from './columns.ts'
import { KIND, MIN_FLOW, SUB, TILE } from './constants.ts'
import { WaterCycle } from './cycle.ts'
import { WaterBodies } from './bodies.ts'
import { WaterEdges } from './edges.ts'
import { WaterMirror, mirrorRun, quantize } from './mirror.ts'
import { WaterPublisher, type WaterTick } from './publish.ts'
import { rebuildSegments, waterKinds } from './rebuild.ts'
import { resegment, type Seg } from './resegment.ts'
import { UnderSegments } from './under.ts'

/** A displaced volume spreads over columns that each take at most this much (1/16 block). */
const DISPLACE_SHARE = SUB / 16
/** The farthest a displaced volume looks for wet columns, in columns. */
const DISPLACE_RADIUS = 32

export interface WaterOptions {
  /** Awake tiles stepped per tick, in tile order, round robin; the rest wait (spec §6 safety net). Integer ≥ 1. Default 1024. */
  tileCap: number
  /** After every step, check Σ depth + sea against the running total and that no depth is negative; on failure log and rebuild. */
  debug: boolean
}
export const DEFAULT_WATER_OPTIONS: WaterOptions = Object.freeze({ tileCap: 1024, debug: false })

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
    const reg = port.registry
    this.water = waterGroupOf(reg)
    if (this.water !== 0 && (reg.opaque[this.water] === 1 || reg.emits[this.water]! > 0)) {
      throw new Error(`block "${reg.name(this.water)}" is the simulated water: it must be transparent and emit no light (mirror writes do not relight)`)
    }
    this.kind = waterKinds(reg, this.water)
    const [sx, , sz] = port.layout.size
    this.cols = new WaterColumns(sx, sz, new Int16Array(port.buffers.floor))
    this.cols.floor.fill(0) // an empty world: every column dry on the world floor
    this.under = new UnderSegments(sx * sz)
    this.edges = new WaterEdges(this.cols.tiles.count)
    this.cols.attach(this.under, this.edges, this.height)
    this.bodies = new WaterBodies(this.cols, this.under, this.edges)
    this.cycle = new WaterCycle(sx * sz)
    this.mirror = new WaterMirror(sx * sz)
    this.stamp = new Int32Array(sx * sz)
    this.seedOf = new Int32Array(sx * sz)
    this.publisher = new WaterPublisher(port.buffers)
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
  get seaLevel(): number { return this.cycle.seaLevel }
  get sea(): number { return this.cycle.sea }
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

  /** Σ depth + sea. */
  total(): number { return this.cols.total() + this.cycle.sea }

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
    const cols = this.cols, T = cols.tiles, sx = cols.sx, floor = cols.floor, depth = cols.depth, mirror = this.mirror, mq = mirror.q, mlo = mirror.lo
    // The mirror writes are quiet (setQuiet): nothing below grows the lower segments, so their arrays hold for the whole loop.
    const U = this.under, first = U.first, next = U.next, uFloor = U.floor, uCeil = U.ceil, uDepth = U.depth, uLo = U.mirrorLo, uQ = U.mirrorQ
    const water = this.water, kind = this.kind, height = this.height, get = this.get, set = this.set
    for (let t = 0; t < T.count; t++) {
      if (T.dirty[t] !== 1) continue
      T.dirty[t] = 0
      out.push(t)
      const x0 = (t % T.tx) * TILE, z0 = Math.floor(t / T.tx) * TILE
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0, c = x0 + z * sx; x < x0 + TILE; x++, c++) {
        const f = floor[c]!, d = depth[c]!, q = mq[c]!
        // Most moving surfaces still occupy the same eighth of a voxel. Avoid the full mirror call for those columns, and
        // for lower segments by the same test (mirrorRun's own early return).
        if (q < 0 || mlo[c] !== f || q !== (d > 0 ? quantize(f * SUB + d) : f * 8)) {
          mirror.flush(c, x, z, f, d, water, kind, height, get, set)
        }
        for (let i = first[c]!; i >= 0; i = next[i]!) {
          const uf = uFloor[i]!, ud = uDepth[i]!, uq = uQ[i]!
          if (uq < 0 || uLo[i] !== uf || uq !== (ud > 0 ? quantize(uf * SUB + ud) : uf * 8)) mirrorRun(uLo, uQ, i, x, z, uf, uCeil[i]!, ud, water, kind, get, set)
        }
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
    if (t !== this.expected) out.push(`Σ depth + sea is ${t}, expected ${this.expected}`)
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

  mixState(mix: (v: number) => void): void {
    mix(this.steps)
    mix(this.needsRebuild ? 1 : 0)
    this.cols.mixState(mix)
    this.cycle.mixState(mix)
    this.mirror.mixState(mix)
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
   * column with a lower segment holding at least MIN_FLOW.
   */
  private wakeUnsettled(x0: number, z0: number, x1: number, z1: number): void {
    const { floor, depth, sx, sz, tiles } = this.cols, mask = this.cycle.mask, U = this.under
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      const c = x + z * sx, d = depth[c]!
      let low = false
      for (let i = U.first[c]!; i >= 0 && !low; i = U.next[i]!) low = U.depth[i]! >= MIN_FLOW
      if (low) { tiles.wake(tiles.of(x, z)); continue }
      if (d < MIN_FLOW || mask[c] === 1) continue
      const s = floor[c]! * SUB + d
      if ((x > 0 && s > this.cols.surface(c - 1)) || (x + 1 < sx && s > this.cols.surface(c + 1)) ||
        (z > 0 && s > this.cols.surface(c - sx)) || (z + 1 < sz && s > this.cols.surface(c + sx))) tiles.wake(tiles.of(x, z))
    }
  }
}
