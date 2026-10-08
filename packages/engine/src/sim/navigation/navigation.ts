import type { Layout } from '../../world/layout.ts'
import type { BlockRegistry } from '../../blocks/registry.ts'
import { voxelId } from '../../world/voxel.ts'

export interface NavigationPort { layout: Layout; registry: BlockRegistry; get(x: number, y: number, z: number): number; safe?(x: number, y: number, z: number): boolean; hazard?(x: number, y: number, z: number): boolean }
export type PathStatus = 'pending' | 'found' | 'unreachable' | 'limited' | 'stale' | 'cancelled'
export interface PathResult { status: PathStatus; path: number[]; cost: number }
/** `allowed` replaces the port policy for this search; `accept` admits any pose as a goal (h = 0 when there are no explicit goals). */
export interface SearchOptions { allowed?(p: number): boolean; accept?(p: number): boolean }
const DX = [1, -1, 0, 0], DZ = [0, 0, 1, -1]
const UNSET = -2
/** First slice of a new search estimated short: such routes finish in it instead of queueing behind long searches. */
const FRESH_SLICE = 512, SHORT_ESTIMATE = 32 * 4
interface Tile { epoch: number; slots: Int16Array; edges: Int32Array; used: number }

/** Lazy support graph. Geometry only: live occupancy, water and structural safety are checked by the executor. */
export class NavigationSystem {
  readonly port: NavigationPort
  readonly revisions: Uint32Array
  revision = 0
  visited = 0
  private readonly tiles = new Map<number, Tile>()
  private readonly tx: number
  private readonly tz: number
  private requests: PathSearch[] = []
  private cursor = 0
  readonly maxNodes: number
  readonly cacheLimit: number
  constructor(port: NavigationPort, maxNodes = 16384, cacheLimit = 512) {
    if (port.layout.voxelCount > 0x80000000) throw new RangeError('navigation needs voxel indices to fit positive int32')
    this.maxNodes = maxNodes; this.cacheLimit = cacheLimit
    this.port = port; this.tx = port.layout.size[0] >> 4; this.tz = port.layout.size[2] >> 4
    this.revisions = new Uint32Array(this.tx * this.tz * (port.layout.size[1] >> 4))
  }
  get pending(): number { let n = 0; for (const s of this.requests) if (s.status === 'pending') n++; return n }
  get cacheTiles(): number { return this.tiles.size }
  get bytes(): number {
    let n = this.revisions.byteLength
    for (const t of this.tiles.values()) n += t.slots.byteLength + t.edges.byteLength
    for (const s of this.requests) n += s.bytes
    return n
  }
  tileOf(x: number, y: number, z: number): number { return (x >> 4) + (z >> 4) * this.tx + (y >> 4) * this.tx * this.tz }
  invalidate(x: number, y: number, z: number): void { this.invalidateBox(x, y, z, x, y, z) }
  /** Edges of a pose read x±1, z±1 and y-3..y+2, so a voxel change reaches only poses in that reverse footprint. */
  invalidateBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const [sx, sy, sz] = this.port.layout.size
    for (let yy = Math.max(0, (y0 - 2) >> 4); yy <= Math.min((sy >> 4) - 1, (y1 + 3) >> 4); yy++)
      for (let zz = Math.max(0, (z0 - 1) >> 4); zz <= Math.min((sz >> 4) - 1, (z1 + 1) >> 4); zz++)
        for (let xx = Math.max(0, (x0 - 1) >> 4); xx <= Math.min((sx >> 4) - 1, (x1 + 1) >> 4); xx++) this.revisions[xx + zz * this.tx + yy * this.tx * this.tz]!++
    this.revision++
  }
  reset(): void { this.tiles.clear(); this.revisions.fill(0); this.revision++; for (const s of this.requests) s.cancel(); this.requests = [] }
  /** Changes to allowed poses invalidate queries without discarding the geometry graph; a box limits it to searches that expanded next to it. */
  invalidatePolicy(min?: readonly number[], max?: readonly number[]): void {
    this.revision++
    for (const s of this.requests) if (!min || !max || this.explored(s, min, max)) s.cancel()
  }
  /** Whether a search expanded a pose with an edge that may reach a pose in the voxel box [min, max]. */
  explored(s: PathSearch, min: readonly number[], max: readonly number[]): boolean {
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
  stand(x: number, y: number, z: number): boolean {
    return this.clear(x, y, z) && this.clear(x, y + 1, z) && (y === 0 || this.port.registry.solid[voxelId(this.port.get(x, y - 1, z))] === 1)
  }
  allowed(p: number): boolean { const c = this.port.layout.voxelCoords(p); return (this.port.safe?.(...c) ?? true) && !(this.port.hazard?.(...c) ?? false) }
  neighbor(p: number, d: number, seen?: Map<number, number>): number {
    const L = this.port.layout, [x, y, z] = L.voxelCoords(p), ti = this.tileOf(x, y, z)
    seen?.set(ti, seen.get(ti) ?? this.revisions[ti]!)
    let tile = this.tiles.get(ti)
    if (!tile || tile.epoch !== this.revisions[ti]) {
      if (!tile && this.tiles.size >= this.cacheLimit) this.tiles.delete(this.tiles.keys().next().value!)
      tile = { epoch: this.revisions[ti]!, slots: new Int16Array(4096).fill(-1), edges: new Int32Array(1024).fill(UNSET), used: 0 }; this.tiles.set(ti, tile)
    }
    const local = (x & 15) + ((z & 15) << 4) + ((y & 15) << 8)
    let slot = tile.slots[local]!
    if (slot < 0) {
      slot = tile.used++; tile.slots[local] = slot
      if (slot * 4 === tile.edges.length) { const a = new Int32Array(tile.edges.length * 2).fill(UNSET); a.set(tile.edges); tile.edges = a }
    }
    const off = slot * 4 + d
    if (tile.edges[off] !== UNSET) return tile.edges[off]!
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
  step(cap: number): void {
    this.visited = 0
    this.requests = this.requests.filter(s => s.status === 'pending')
    // New short searches share half the budget; the rest (and any leftover) goes to a bounded FIFO window,
    // which completes long searches one batch at a time instead of slicing all of them at once.
    let share = cap >> 1
    for (const s of this.requests) {
      if (share <= 0) break
      if (s.spent || s.estimate > SHORT_ESTIMATE) continue
      const used = s.step(Math.min(share, FRESH_SLICE)); share -= used; cap -= used; this.visited += used
    }
    this.requests = this.requests.filter(s => s.status === 'pending')
    let guard = this.requests.length
    while (cap > 0 && this.requests.length && guard > 0) {
      this.cursor %= Math.min(4, this.requests.length)
      const s = this.requests[this.cursor]!, used = s.step(Math.min(cap, 128))
      cap -= used; this.visited += used
      if (s.status !== 'pending') { this.requests.splice(this.cursor, 1); guard = this.requests.length }
      else { this.cursor++; guard = used ? this.requests.length : guard - 1 }
    }
  }
  mixState(mix: (n: number) => void): void {
    mix(this.revision); mix(this.cursor); mix(this.maxNodes); mix(this.revisions.length); for (const r of this.revisions) mix(r)
    mix(this.requests.length)
    for (const s of this.requests) s.mixState(mix)
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
  constructor(nav: NavigationSystem, start: number, goals: readonly number[], blocked?: ReadonlySet<number>, options?: SearchOptions) {
    this.nav = nav; this.goals = goals; this.blocked = blocked; this.allow = options?.allowed; this.accept = options?.accept
    this.goalSet = new Set(goals)
    this.estimate = this.h(start)
    if (!goals.length && !this.accept || !nav.stand(...nav.port.layout.voxelCoords(start))) { this.status = 'unreachable'; return }
    this.add(start, 0, -1)
  }
  get bytes(): number { return this.positions.byteLength * 6 }
  cancel(): void { this.status = 'cancelled' }
  result(): PathResult { return { status: this.status, path: this.path, cost: this.cost } }
  private permits(p: number): boolean { return this.allow ? this.allow(p) : this.nav.allowed(p) }
  private h(p: number): number {
    if (!this.goals.length) return 0
    const [x, y, z] = this.nav.port.layout.voxelCoords(p)
    let h = 0xffffffff
    for (const goal of this.goals) {
      const [gx, gy, gz] = this.nav.port.layout.voxelCoords(goal)
      h = Math.min(h, (Math.abs(x - gx) + Math.abs(z - gz)) * 4 + Math.max(0, gy - y) * 2)
    }
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
  private add(p: number, g: number, parent: number): void {
    let id = this.ids.get(p)
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
        else this.status = this.path.length ? 'found' : 'unreachable'
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
        const L = this.nav.port.layout, p = this.positions[this.expanding]!, to = this.nav.neighbor(p, this.direction, this.seen)
        if (to >= 0 && !this.blocked?.has(to) && this.permits(to)) {
          const sy = L.voxelCoords(p)[1], ty = L.voxelCoords(to)[1]
          this.add(to, this.gs[this.expanding]! + 4 + (ty > sy ? 2 : sy - ty), this.expanding)
        }
        if (++this.direction === 4) this.expanding = -1
      }
    }
    this.spent += used
    return used
  }
  mixState(mix: (n: number) => void): void {
    const numbers = (values: readonly number[]) => { mix(values.length); for (const n of values) mix(n) }
    mix(['pending', 'found', 'unreachable', 'limited', 'stale', 'cancelled'].indexOf(this.status)); mix(this.validationProgress); mix(this.cost); mix(this.spent); mix(this.allow ? 1 : 0); mix(this.accept ? 1 : 0)
    mix(['search', 'path', 'reverse', 'validate'].indexOf(this.phase)); mix(this.validateRevision); mix(this.reverseCursor)
    numbers(this.goals); numbers([...(this.blocked ?? [])].sort((a, b) => a - b))
    mix(this.count); mix(this.size); mix(this.expanding); mix(this.direction); mix(this.reconstruct)
    for (let i = 0; i < this.count; i++) { mix(this.positions[i]!); mix(this.gs[i]!); mix(this.hs[i]!); mix(this.parents[i]!); mix(this.indices[i]!) }
    for (let i = 0; i < this.size; i++) mix(this.heap[i]!)
    numbers(this.path); mix(this.seen.size)
    for (const [p, e] of this.seen) { mix(p); mix(e) }
  }
}
