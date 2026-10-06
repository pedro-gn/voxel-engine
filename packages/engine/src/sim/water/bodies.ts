import { damp, moved, type StepHooks, type WaterColumns } from './columns.ts'
import { BISECT_ROUNDS, FLUX_FP, LEAVE, MAX_HEAD, MIN_FLOW, SUB } from './constants.ts'
import type { TileEdges, WaterEdges } from './edges.ts'
import type { UnderSegments } from './under.ts'

/** Connected full lower segments that carry pressure (3d spec §4; plan design notes: Bodies). */
export class Body {
  /** Lower segment indices, in position order (column, then bottom-up). */
  members: number[] = []
  /** Members by ceiling ascending, then position: filled first, so deficits sit at the top. */
  fill: number[] = []
  /** Boundary edges: tile, index in its TileEdges, and +1 when the member is the edge's b (positive flux flows in), −1 when it is a. */
  bTile: number[] = []
  bEdge: number[] = []
  bSide: number[] = []
  /** Tiles of its boundary edges, ascending, once each. */
  tiles: number[] = []
  capSum = 0
  maxCeil = 0
  /** Members whose ceiling is maxCeil: the top layer, which holds the deficit. */
  topCount = 0
  excess = 0
  /** Its level at its last step (1/SUB block). */
  level = 0
  /** The step it last stepped (rebalance runs for those only). */
  stepped = -1
}

/** Rounds a stored flux's share: scaled() of columns.ts, for a body's outflows. */
function scaleFlux(f: number, d: number, out: number): number { return Math.floor(((f >> FLUX_FP) * d) / out) << FLUX_FP }

export class WaterBodies implements StepHooks {
  list: Body[] = []
  private readonly cols: WaterColumns
  private readonly under: UnderSegments
  private readonly edges: WaterEdges
  private seeds: number[] = []
  /** Per lower segment: the search's generation that visited it, and whether it was a member of a body dropped since the last ensure(). */
  private visited = new Int32Array(0)
  private wasMember = new Int32Array(0)
  private gen = 0
  private searching = false

  constructor(cols: WaterColumns, under: UnderSegments, edges: WaterEdges) {
    this.cols = cols
    this.under = under
    this.edges = edges
    cols.hooks(this)
    cols.bodyLevel = (ref) => this.list[under.body[ref - cols.n]!]!.level
  }

  seed(i: number): void { this.seeds.push(i) }

  /** Seeds every full lower segment (after a rebuild from the voxels). */
  seedFull(): void {
    const U = this.under
    for (let c = 0; c < U.n; c++) for (let i = U.first[c]!; i >= 0; i = U.next[i]!) if (U.depth[i]! + U.excess[i]! >= U.cap(i)) this.seeds.push(i)
  }

  filled(i: number): void { this.seeds.push(i) }

  /** Drops body `id`: its members go back to free (seeded, so they regroup at ensure()), its excess to its first member. */
  dropBody(id: number): void {
    const b = this.list[id]
    if (!b) return
    const U = this.under
    this.sizeScratch()
    // Tagged with the generation of the search that regroups them: the current one while searching, else the next.
    const tag = this.searching ? this.gen : this.gen + 1
    for (const m of b.members) { U.body[m] = -1; this.wasMember[m] = tag; this.seeds.push(m) }
    if (b.excess > 0) { U.excess[b.members[0]!] = U.excess[b.members[0]!]! + b.excess; b.excess = 0 }
    b.members = []
  }

  /** Drops every body (a rebuild from the voxels follows; their excess is discarded with the old segments). */
  dropAll(): void {
    for (const b of this.list) for (const m of b.members) this.under.body[m] = -1
    this.list = []
    this.seeds = []
  }

  excessTotal(): number {
    let s = 0
    for (const b of this.list) s += b.excess
    return s
  }

  /** Bodies with a boundary edge in a tile that `stepping` marks (all bodies with a boundary when omitted). */
  activeCount(stepping?: Uint8Array): number {
    let n = 0
    for (const b of this.list) if (b.tiles.length > 0 && (!stepping || b.tiles.some((t) => stepping[t] === 1))) n++
    return n
  }

  /** Regroups bodies: those touched by rebuilt edge lists or by seeds, then a search from the seeds over candidates. */
  ensure(): void {
    const U = this.under, E = this.edges
    this.sizeScratch()
    if (E.rebuilt.length > 0) for (let id = 0; id < this.list.length; id++) {
      const b = this.list[id]!
      if (b.members.length > 0 && b.tiles.some((t) => E.rebuilt.includes(t))) this.dropBody(id)
    }
    for (const s of this.seeds.slice()) if (U.col[s]! >= 0 && U.body[s]! >= 0) this.dropBody(U.body[s]!)
    if (this.seeds.length === 0) { this.compact(); return }
    const gen = ++this.gen, seeds = this.seeds
    this.seeds = []
    this.searching = true
    const fresh: Body[] = []
    for (const s of seeds) {
      if (U.col[s]! < 0 || this.visited[s] === gen || !this.candidate(s, gen)) continue
      const members: number[] = [s]
      this.visited[s] = gen
      for (let q = 0; q < members.length; q++) this.neighbours(members[q]!, gen, members)
      const b = new Body()
      b.members = members
      fresh.push(b)
    }
    this.searching = false
    // Members of kept bodies the search merged were seeded again: drop those already grouped this round.
    this.seeds = this.seeds.filter((m) => U.col[m]! >= 0 && this.visited[m] !== gen)
    this.compact()
    for (const b of fresh) this.list.push(b)
    this.list.sort((p, q) => this.position(p.members[0]!) - this.position(q.members[0]!))
    for (let id = 0; id < this.list.length; id++) for (const m of this.list[id]!.members) U.body[m] = id
    for (const b of fresh) this.finish(b)
  }

  /** Sets every collected boundary edge of each body that has one (plan design notes: Bodies, Step). */
  step(stepping: Uint8Array, gain: number): void {
    const U = this.under, cols = this.cols, no = cols.stepNo, T = cols.tiles
    for (const b of this.list) {
      let active = false
      for (let k = 0; k < b.bTile.length && !active; k++) active = this.edges.tiles[b.bTile[k]!]!.seen[b.bEdge[k]!] === no
      if (!active) continue
      b.stepped = no
      for (const t of b.tiles) if (T.awake[t] === 0) T.wake(t) // pressure reaches every opening: the far side steps next
      let V = b.excess, hiS = -Infinity
      for (const m of b.members) V += U.depth[m]!
      for (let k = 0; k < b.bTile.length; k++) {
        const L = this.edges.tiles[b.bTile[k]!]!, e = b.bEdge[k]!
        if (L.seen[e] !== no) continue
        const s = this.freeSurface(L, e, b.bSide[k]!)
        if (s > hiS) hiS = s
      }
      // Its own water's level: the top layer's surface (rebalance spreads the deficit evenly over that layer).
      const Hb = b.maxCeil * SUB - Math.ceil(Math.max(0, b.capSum - V) / b.topCount)
      const hi = Math.max(Hb, hiS) + MAX_HEAD + 1
      const target = b.excess > 0 ? -b.excess : 0
      let H = Hb
      if (this.inflow(b, Hb, gain, false) > target) {
        if (this.inflow(b, hi, gain, false) > target) H = hi
        else {
          let lo = Hb, up = hi
          for (let r = 0; r < BISECT_ROUNDS && up - lo > 1; r++) {
            const mid = lo + Math.floor((up - lo) / 2)
            if (this.inflow(b, mid, gain, false) <= target) up = mid
            else lo = mid
          }
          H = up
        }
      }
      this.inflow(b, H, gain, true)
      b.level = H
      // A body never sends more than it holds.
      let out = 0
      for (let k = 0; k < b.bTile.length; k++) {
        const L = this.edges.tiles[b.bTile[k]!]!, e = b.bEdge[k]!
        if (L.seen[e] !== no) continue
        const into = b.bSide[k]! > 0 ? moved(L.flux[e]!) : -moved(L.flux[e]!)
        if (into < 0) out -= into
      }
      if (out > V) for (let k = 0; k < b.bTile.length; k++) {
        const L = this.edges.tiles[b.bTile[k]!]!, e = b.bEdge[k]!, f = L.flux[e]!
        if (L.seen[e] !== no) continue
        const sends = b.bSide[k]! > 0 ? f < 0 : f > 0
        if (sends) L.flux[e] = f > 0 ? scaleFlux(f, V, out) : -scaleFlux(-f, V, out)
      }
    }
  }

  /**
   * After the transfer: each stepped body fills its members layer by layer, lowest ceiling first. The layer the water runs
   * out in shares its deficit evenly (an even surface: its members leave together, never one at a time to be refilled by
   * the rest); layers above it are emptied. What is left over is excess. A member past LEAVE is seeded to leave.
   */
  rebalance(): void {
    const U = this.under, no = this.cols.stepNo, T = this.cols.tiles, sx = this.cols.sx
    const set = (m: number, d: number) => {
      if (U.depth[m] === d) return
      U.depth[m] = d
      const c = U.col[m]!
      T.dirty[T.of(c % sx, Math.floor(c / sx))] = 1
    }
    for (const b of this.list) {
      if (b.stepped !== no) continue
      let rest = b.excess
      for (const m of b.members) rest += U.depth[m]!
      for (let k = 0; k < b.fill.length;) {
        const ce = U.ceil[b.fill[k]!]!, j0 = k
        let gcap = 0
        while (k < b.fill.length && U.ceil[b.fill[k]!] === ce) gcap += U.cap(b.fill[k++]!)
        if (rest >= gcap) { for (let j = j0; j < k; j++) set(b.fill[j]!, U.cap(b.fill[j]!)); rest -= gcap; continue }
        // The deficit gcap − rest spread evenly; a member too shallow for its share is emptied and the others take the rest.
        let def = gcap - rest, cnt = k - j0
        const order = b.fill.slice(j0, k).sort((p, q) => U.cap(p) - U.cap(q) || this.position(p) - this.position(q))
        for (const m of order) {
          const dm = Math.min(U.cap(m), Math.ceil(def / cnt))
          set(m, U.cap(m) - dm)
          def -= dm
          cnt--
        }
        rest = 0
      }
      b.excess = rest
      for (const m of b.members) if (U.cap(m) - U.depth[m]! > LEAVE) this.seeds.push(m)
      if (b.excess > 0) for (const t of b.tiles) if (T.awake[t] === 0) T.wake(t)
    }
  }

  mixState(mix: (v: number) => void): void {
    mix(this.list.length)
    for (const b of this.list) {
      mix(b.members.length); mix(b.excess); mix(b.level)
      for (const m of b.members) mix(this.position(m))
    }
  }

  /**
   * Net water (1/SUB block, moved as transfer will move it) the body takes in through its collected boundary edges at level
   * H; `store` writes those fluxes. A boundary edge is accelerated as 3c's with H as the member side's surface: the body
   * sends only while H is above the opening's floor; a free side sends only at least MIN_FLOW deep and above it.
   */
  private inflow(b: Body, H: number, gain: number, store: boolean): number {
    const cols = this.cols, U = this.under, n = cols.n, no = cols.stepNo
    let net = 0
    for (let k = 0; k < b.bTile.length; k++) {
      const L = this.edges.tiles[b.bTile[k]!]!, e = b.bEdge[k]!
      if (L.seen[e] !== no) continue
      const side = b.bSide[k]!, free = side > 0 ? L.a[e]! : L.b[e]!, lo = L.lo[e]! * SUB
      const df = free < n ? cols.depth[free]! : U.depth[free - n]!
      const sf = (free < n ? cols.floor[free]! : U.floor[free - n]!) * SUB + df
      let h = side > 0 ? sf - H : H - sf
      if (h > MAX_HEAD) h = MAX_HEAD
      else if (h < -MAX_HEAD) h = -MAX_HEAD
      let f = damp(L.flux[e]!) + h * gain
      if (f !== 0) {
        const freeSends = (f > 0) === (side > 0)
        if (freeSends ? df < MIN_FLOW || sf <= lo : H <= lo) f = 0
      }
      if (store) L.flux[e] = f
      net += side > 0 ? moved(f) : -moved(f)
    }
    return net
  }

  /** The surface of the free side of a boundary edge. */
  private freeSurface(L: TileEdges, e: number, side: number): number {
    const cols = this.cols, U = this.under, n = cols.n, free = side > 0 ? L.a[e]! : L.b[e]!
    return free < n ? cols.surface(free) : U.surface(free - n)
  }

  /** A lower segment that joins a body: full (excess counts), or one dropped from a body this round still within LEAVE. */
  private candidate(i: number, gen: number): boolean {
    const U = this.under
    if (U.depth[i]! + U.excess[i]! >= U.cap(i)) return true
    return this.wasMember[i] === gen && U.cap(i) - U.depth[i]! <= LEAVE
  }

  /** Adds the candidate lower segments overlapping i in its 4 neighbour columns; a member of a kept body drops it (merge). */
  private neighbours(i: number, gen: number, out: number[]): void {
    const U = this.under, cols = this.cols, sx = cols.sx, sz = cols.sz, c = U.col[i]!, x = c % sx, z = (c - x) / sx
    const f = U.floor[i]!, ce = U.ceil[i]!
    for (let d = 0; d < 4; d++) {
      const nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0), nz = z + (d === 2 ? 1 : d === 3 ? -1 : 0)
      if (nx < 0 || nz < 0 || nx >= sx || nz >= sz) continue
      const nc = nx + nz * sx
      for (let j = U.first[nc]!; j >= 0; j = U.next[j]!) {
        if (U.floor[j]! >= ce || U.ceil[j]! <= f || this.visited[j] === gen) continue
        if (U.body[j]! >= 0) this.dropBody(U.body[j]!)
        if (!this.candidate(j, gen)) continue
        this.visited[j] = gen
        out.push(j)
      }
    }
  }

  /** Fill order, capacity, excess and boundary edges of a new body. */
  private finish(b: Body): void {
    const U = this.under, cols = this.cols, n = cols.n, sx = cols.sx, T = cols.tiles, E = this.edges
    b.members.sort((p, q) => this.position(p) - this.position(q))
    b.fill = b.members.slice().sort((p, q) => U.ceil[p]! - U.ceil[q]! || this.position(p) - this.position(q))
    b.capSum = 0; b.maxCeil = 0; b.excess = 0; b.topCount = 0
    for (const m of b.members) {
      b.capSum += U.cap(m)
      if (U.ceil[m]! > b.maxCeil) b.maxCeil = U.ceil[m]!
      b.excess += U.excess[m]!
      U.excess[m] = 0
    }
    for (const m of b.members) if (U.ceil[m] === b.maxCeil) b.topCount++
    const id = U.body[b.members[0]!]!
    const tiles = new Set<number>()
    for (const m of b.members) {
      const c = U.col[m]!, x = c % sx, z = (c - x) / sx
      tiles.add(T.of(x, z))
      if (x > 0) tiles.add(T.of(x - 1, z))
      if (z > 0) tiles.add(T.of(x, z - 1))
    }
    const sorted = [...tiles].sort((p, q) => p - q)
    const inBody = (ref: number) => ref >= n && U.body[ref - n] === id
    for (const t of sorted) {
      const L = E.tiles[t]
      if (!L) continue
      for (let e = 0; e < L.count; e++) {
        const ia = inBody(L.a[e]!), ib = inBody(L.b[e]!)
        if (ia && ib) { L.flux[e] = 0; continue } // inside the body: nothing flows
        if (ia === ib) continue
        b.bTile.push(t); b.bEdge.push(e); b.bSide.push(ib ? 1 : -1)
      }
    }
    b.tiles = [...new Set(b.bTile)].sort((p, q) => p - q)
    b.level = b.maxCeil * SUB
    if (b.excess > 0) for (const t of b.tiles) if (T.awake[t] === 0) T.wake(t)
  }

  /** A lower segment's position: column, then floor (never its pool index). */
  private position(i: number): number { return this.under.col[i]! * 65536 + this.under.floor[i]! }

  /** Removes emptied bodies and renumbers members. */
  private compact(): void {
    const U = this.under
    this.list = this.list.filter((b) => b.members.length > 0)
    for (let id = 0; id < this.list.length; id++) for (const m of this.list[id]!.members) U.body[m] = id
  }

  private sizeScratch(): void {
    const m = this.under.col.length
    if (this.visited.length >= m) return
    const v = new Int32Array(m); v.set(this.visited); this.visited = v
    const w = new Int32Array(m); w.set(this.wasMember); this.wasMember = w
  }
}
