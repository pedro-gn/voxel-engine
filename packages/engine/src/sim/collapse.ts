import type { BlockRegistry } from '../blocks/registry.ts'
import type { Layout } from '../world/layout.ts'
import { AIR, voxelId } from '../world/voxel.ts'
import { GRAVITY_256, MAX_FALL_256 } from './gravity.ts'
import type { Packed } from '../persist/pack.ts'

interface CollapseJson { nextId: number; dirty: number[]; scanChunk: number | null; scanCell: number; fragments: { id: number; offset256: number; vy256: number; n: number }[] }

export interface CollapseOptions { scanCap?: number; mutationCap?: number; fragmentCells?: number; maxFragments?: number }
export class FragmentOverlapError extends Error {
  constructor(message: string) { super(message); this.name = 'FragmentOverlapError' }
}
export interface CollapseStats { checks: number; fragments: number; cells: number; visited: number; mutations: number; restarts: number }
export interface ChunkVersion { chunk: number; version: number }
/** Positions are original world indices; a fragment only translates vertically. Membership is sent once. */
/** `offset256`: where the fragment already is (a fragment re-announced after a load); absent for a new one, which starts at 0. */
export interface FragmentBirth { id: number; positions: Uint32Array; voxels: Uint16Array; source: ChunkVersion[]; offset256?: number }
export interface FragmentLanding { id: number; offset256: number; chunks: ChunkVersion[] }
export interface CollapseTick { born: FragmentBirth[]; poses: Int32Array; landed: FragmentLanding[] }
export interface CollapsePort {
  trackSweeps?: boolean
  layout: Layout; registry: BlockRegistry
  get(x: number, y: number, z: number): number
  write(x: number, y: number, z: number, voxel: number): void
  prepare(chunks: readonly number[]): void
  touch(chunks: readonly number[]): void
  /** Highest top of another falling block crossed by this downward sweep. */
  fallingFloor(x: number, z: number, from256: number, to256: number): number | undefined
}

const DX = [1, -1, 0, 0, 0, 0], DY = [0, 0, 1, -1, 0, 0], DZ = [0, 0, 0, 0, 1, -1]

/** Reusable sparse visitation: 4 KiB per touched 32³ chunk, reset lazily by generation. */
class Bits {
  private readonly pages = new Map<number, { generation: number; bits: Uint32Array }>()
  generation = 1
  readonly layout: Layout
  constructor(layout: Layout) { this.layout = layout }
  reset(): void { this.generation++; if (this.generation > Number.MAX_SAFE_INTEGER - 1) { this.pages.clear(); this.generation = 1 } }
  has(x: number, y: number, z: number): boolean {
    const page = this.pages.get(this.layout.chunkOf(x, y, z)), li = (x & 31) + ((z & 31) << 5) + ((y & 31) << 10)
    return !!page && page.generation === this.generation && (page.bits[li >>> 5]! & (1 << (li & 31))) !== 0
  }
  set(x: number, y: number, z: number, value: boolean): void {
    const ci = this.layout.chunkOf(x, y, z), li = (x & 31) + ((z & 31) << 5) + ((y & 31) << 10)
    let page = this.pages.get(ci)
    if (!page) { page = { generation: this.generation, bits: new Uint32Array(1024) }; this.pages.set(ci, page) }
    if (page.generation !== this.generation) { page.bits.fill(0); page.generation = this.generation }
    const w = li >>> 5, mask = 1 << (li & 31)
    if (value) page.bits[w] |= mask; else page.bits[w] &= ~mask
  }
  mixState(mix: (v: number) => void): void {
    const current = [...this.pages].filter(([, p]) => p.generation === this.generation).sort(([a], [b]) => a - b)
    mix(current.length)
    for (const [ci, p] of current) { mix(ci); for (const word of p.bits) mix(word) }
  }
}

class Positions {
  data = new Uint32Array(1024)
  length = 0
  push(p: number): void {
    if (this.length === this.data.length) { const next = new Uint32Array(this.data.length * 2); next.set(this.data); this.data = next }
    this.data[this.length++] = p
  }
}

interface Search {
  queue: Positions; head: number; cursor: number; epochs: Map<number, number>
  phase: 'search' | 'supported' | 'detach' | 'requeue'; invalid: boolean; usedCache: boolean
  remaining: number
}
interface Run { x: number; z: number; y: number; height: number }
interface Fragment { id: number; positions: Uint32Array; voxels: Uint16Array; runs: Run[]; offset256: number; vy256: number }
interface Occupied { id: number; bottom256: number; top256: number }

/** Exact edit-driven support checks and connected vertical fragments. All caps count work, never clocks. */
export class CollapseSystem {
  private readonly swept = new Map<number, { lo: number; hi: number }[]>()
  get checking(): boolean { return !!this.search || this.seedSet.size > 0 || this.dirty.size > 0 || this.scanChunk !== null }
  sweptOverlaps(x: number, y: number, z: number): boolean {
    return this.overlaps(x, y, z) || (this.swept.get(x + z * this.port.layout.size[0])?.some(b => y * 256 < b.hi && (y + 1) * 256 > b.lo) ?? false)
  }
  readonly enabled: boolean
  private readonly port: CollapsePort
  private readonly scanCap: number
  private readonly mutationCap: number
  private readonly fragmentCells: number
  private readonly maxFragments: number
  private readonly epochs: Uint32Array
  private readonly counts: Uint32Array
  private readonly members: Bits
  private readonly supported: Bits
  private readonly scratch = new Positions()
  private seeds: number[] = []
  private seedHead = 0
  private readonly seedSet = new Set<number>()
  private readonly dirty = new Set<number>()
  private scanChunk: number | null = null
  private scanCell = 0
  private search: Search | null = null
  private fragments: Fragment[] = []
  private readonly occupied = new Map<number, Occupied[]>()
  private nextId = 1
  private selfWrite = false
  private born: FragmentBirth[] = []
  /** Set by restore(): the next step keeps the births it queued for the main thread. */
  private keepBorn = false
  private landed: FragmentLanding[] = []
  private visited = 0
  private mutations = 0
  private restarts = 0
  private memberTotal = 0

  constructor(port: CollapsePort, options: CollapseOptions = {}) {
    this.port = port; this.enabled = port.registry.hasCollapse
    if (this.enabled && port.layout.voxelCount > 0xffffffff) throw new RangeError('collapse requires at most 2^32 - 1 world cells')
    this.scanCap = options.scanCap ?? 4096; this.mutationCap = options.mutationCap ?? 128
    this.fragmentCells = options.fragmentCells ?? Math.min(256, this.mutationCap); this.maxFragments = options.maxFragments ?? 64
    for (const [name, n] of Object.entries({ scanCap: this.scanCap, mutationCap: this.mutationCap, fragmentCells: this.fragmentCells, maxFragments: this.maxFragments })) {
      if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`collapse ${name} must be a positive integer`)
    }
    if (this.fragmentCells > this.mutationCap || this.fragmentCells > 4096) throw new RangeError('collapse fragmentCells must be <= mutationCap and <= 4096')
    this.epochs = new Uint32Array(this.enabled ? port.layout.chunkCount : 0)
    this.counts = new Uint32Array(this.enabled ? port.layout.chunkCount : 0)
    this.members = new Bits(port.layout); this.supported = new Bits(port.layout)
  }

  get busy(): boolean { return !!this.search || this.seedSet.size > 0 || this.dirty.size > 0 || this.scanChunk !== null || this.fragments.length > 0 }
  stats(): CollapseStats {
    return { checks: this.seedSet.size + (this.search ? 1 : 0) + this.dirty.size + (this.scanChunk === null ? 0 : 1), fragments: this.fragments.length,
      cells: this.fragments.reduce((n, b) => n + b.positions.length, 0), visited: this.visited, mutations: this.mutations, restarts: this.restarts }
  }

  afterWrite(x: number, y: number, z: number, old: number, value: number): void {
    if (!this.enabled) return
    const classes = this.port.registry.structural, a = classes[voxelId(old)], b = classes[voxelId(value)]
    if (a === b) return
    const ci = this.port.layout.chunkOf(x, y, z)
    if (a === 1) this.counts[ci]!--
    if (b === 1) this.counts[ci]!++
    if (a === 1) this.memberTotal--
    if (b === 1) this.memberTotal++
    if (!this.memberTotal && !this.busy) return
    this.changed(ci)
    if (b === 1) this.seed(x, y, z)
    for (let d = 0; d < 6; d++) this.seed(x + DX[d]!, y + DY[d]!, z + DZ[d]!)
  }

  /** Called on bulk writes; normal chunks have no queued scan. */
  replaceChunk(ci: number, voxels: Uint16Array, initial = false): void {
    if (!this.enabled) return
    const local: number[] = []
    const collapses = this.port.registry.collapses
    for (let i = 0; i < voxels.length; i++) if (collapses[voxelId(voxels[i]!)] === 1) local.push(i)
    const count = local.length
    this.memberTotal += count - this.counts[ci]!
    this.counts[ci] = count
    if (!this.memberTotal && !this.busy) return
    this.changed(ci)
    const [cx, cy, cz] = this.port.layout.chunkCoords(ci)
    for (const p of local) this.seed(cx * 32 + (p & 31), cy * 32 + (p >>> 10), cz * 32 + ((p >>> 5) & 31))
    if (initial) return // every initial member is already seeded; do not rescan neighboring chunks
    for (let d = 0; d < 6; d++) {
      const nx = cx + DX[d]!, ny = cy + DY[d]!, nz = cz + DZ[d]!
      if (this.port.layout.chunkInBounds(nx, ny, nz)) { const neighbor = this.port.layout.chunkIndex(nx, ny, nz); if (this.counts[neighbor]) this.dirty.add(neighbor) }
    }
  }

  /** A moving cell may occupy two grid cells between integer heights. */
  overlaps(x: number, y: number, z: number): boolean {
    const entries = this.occupied.get(x + z * this.port.layout.size[0])
    return entries?.some(e => y * 256 < e.top256 && (y + 1) * 256 > e.bottom256) ?? false
  }
  overlapsColumn(cx: number, cz: number): boolean {
    for (const b of this.fragments) for (const r of b.runs) if ((r.x >> 5) === cx && (r.z >> 5) === cz) return true
    return false
  }
  floor(x: number, z: number, from256: number, to256: number, exclude = -1): number | undefined {
    let top: number | undefined
    for (const e of this.occupied.get(x + z * this.port.layout.size[0]) ?? []) {
      if (e.id !== exclude && e.top256 <= from256 && e.top256 > to256 && (top === undefined || e.top256 > top)) top = e.top256
    }
    return top
  }

  step(): void {
    this.swept.clear()
    // Births a restore queued are announced by the first publication, even when this step runs before it.
    if (!this.keepBorn) this.born = []
    this.keepBorn = false
    this.landed = []; this.visited = 0; this.mutations = 0
    if (!this.enabled) return
    // Landings and detachments share the mutation allowance. An entire admitted body fits it.
    this.advance()
    let budget = this.scanCap
    const L = this.port.layout, sx = L.size[0], plane = sx * L.size[2]
    while (budget > 0) {
      if (!this.search && (this.scanChunk !== null || this.dirty.size > 0)) {
        if (this.scanChunk === null) { this.scanChunk = this.dirty.values().next().value!; this.dirty.delete(this.scanChunk); this.scanCell = 0 }
        const [cx, cy, cz] = L.chunkCoords(this.scanChunk)
        while (budget > 0 && this.scanCell < 32768) {
          const p = this.scanCell++; budget--; this.visited++
          this.seed(cx * 32 + (p & 31), cy * 32 + (p >>> 10), cz * 32 + ((p >>> 5) & 31))
        }
        if (this.scanCell === 32768) this.scanChunk = null
        if (budget === 0) break
      }
      if (!this.search) {
        if (this.seedHead >= this.seeds.length) { this.seeds = []; this.seedHead = 0; break }
        const p = this.seeds[this.seedHead++]!; this.seedSet.delete(p); budget--; this.visited++
        const x = p % sx, y = Math.floor(p / plane), z = Math.floor((p % plane) / sx)
        if (this.port.registry.structural[voxelId(this.port.get(x, y, z))] !== 1 || this.supported.has(x, y, z)) continue
        this.members.reset(); this.scratch.length = 0; this.scratch.push(p); this.members.set(x, y, z, true)
        this.search = { queue: this.scratch, head: 0, cursor: 0, epochs: new Map(), phase: 'search', invalid: false, usedCache: false, remaining: 0 }
      }
      const job = this.search
      if (job.invalid && job.phase !== 'requeue') { job.phase = 'requeue'; job.cursor = 0; this.restarts++ }
      if (job.phase === 'supported' || job.phase === 'requeue') {
        while (budget > 0 && job.cursor < job.queue.length) {
          const p = job.queue.data[job.cursor++]!, x = p % sx, y = Math.floor(p / plane), z = Math.floor((p % plane) / sx)
          budget--; this.visited++
          if (job.phase === 'supported') this.supported.set(x, y, z, true); else this.seed(x, y, z)
        }
        if (job.cursor === job.queue.length) this.search = null
        continue
      }
      if (job.phase === 'search') {
        while (budget > 0 && job.head < job.queue.length && job.phase === 'search') {
          const p = job.queue.data[job.head++]!, x = p % sx, y = Math.floor(p / plane), z = Math.floor((p % plane) / sx)
          budget--; this.visited++
          if (y === 0) { job.phase = 'supported'; break }
          for (let d = 0; d < 6; d++) {
            const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
            if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= L.size[1] || nz >= L.size[2]) continue
            const ci = L.chunkOf(nx, ny, nz)
            if (!job.epochs.has(ci)) job.epochs.set(ci, this.epochs[ci]!)
            const role = this.port.registry.structural[voxelId(this.port.get(nx, ny, nz))]
            if (role === 2 || (role === 1 && this.supported.has(nx, ny, nz))) { job.usedCache = role === 1; job.phase = 'supported'; break }
            if (role === 1 && !this.members.has(nx, ny, nz)) { this.members.set(nx, ny, nz, true); job.queue.push(L.voxelIndex(nx, ny, nz)) }
          }
        }
        if (job.phase === 'search' && job.head === job.queue.length) { job.phase = 'detach'; job.remaining = job.queue.length }
        continue
      }
      if (this.fragments.length >= this.maxFragments || this.mutationCap - this.mutations < 1) break
      // Every subset is connected: expand only from cells already selected, stopping before its cap.
      let root = -1
      while (budget > 0 && job.cursor < job.queue.length) {
        const p = job.queue.data[job.cursor++]!, x = p % sx, y = Math.floor(p / plane), z = Math.floor((p % plane) / sx)
        budget--; this.visited++
        if (this.members.has(x, y, z)) {
          // A partial fragment cannot sit on another pending grid member. Defer roots until their base is selected.
          if (job.remaining > Math.min(this.fragmentCells, budget + 1, this.mutationCap - this.mutations) && y > 0 && this.members.has(x, y - 1, z)) { job.queue.push(p); continue }
          root = p; break
        }
      }
      if (root < 0) { if (job.cursor === job.queue.length) this.search = null; continue }
      const limit = Math.min(this.fragmentCells, budget + 1, this.mutationCap - this.mutations)
      const partial = job.remaining > limit
      const chosen = [root]
      const select = (p: number) => { const x = p % sx, y = Math.floor(p / plane), z = Math.floor((p % plane) / sx); this.members.set(x, y, z, false) }
      select(root)
      for (let head = 0; head < chosen.length && chosen.length < limit; head++) {
        const p = chosen[head]!, x = p % sx, y = Math.floor(p / plane), z = Math.floor((p % plane) / sx)
        for (let d = 0; d < 6 && chosen.length < limit; d++) {
          const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
          if (nx < 0 || ny < 0 || nz < 0 || nx >= sx || ny >= L.size[1] || nz >= L.size[2] || !this.members.has(nx, ny, nz)) continue
          if (partial && ny > 0 && this.members.has(nx, ny - 1, nz)) continue
          const next = L.voxelIndex(nx, ny, nz); select(next); chosen.push(next)
        }
      }
      budget -= chosen.length - 1; this.visited += chosen.length - 1
      job.remaining -= chosen.length
      this.detach(Uint32Array.from(chosen))
    }
  }

  publication(versions: Uint32Array): CollapseTick | undefined {
    if (!this.enabled || (!this.born.length && !this.landed.length && !this.fragments.length)) return undefined
    for (const e of this.born) for (const v of e.source) v.version = versions[v.chunk]!
    for (const e of this.landed) for (const v of e.chunks) v.version = versions[v.chunk]!
    const poses = new Int32Array(this.fragments.length * 3)
    this.fragments.forEach((b, i) => { poses[i * 3] = b.id; poses[i * 3 + 1] = b.offset256; poses[i * 3 + 2] = b.vy256 })
    const result = { born: this.born, landed: this.landed, poses }
    this.born = []; this.landed = []
    return result
  }

  /** Plan deviation 5: an in-progress support search is not kept; its queued positions are seeded again. */
  snapshot(): Packed {
    const seeds = new Set<number>(this.seeds.slice(this.seedHead))
    if (this.search) for (let i = 0; i < this.search.queue.length; i++) seeds.add(this.search.queue.data[i]!)
    const total = this.fragments.reduce((n, f) => n + f.positions.length, 0)
    const positions = new Uint32Array(total), voxels = new Uint16Array(total)
    let at = 0
    for (const f of this.fragments) { positions.set(f.positions, at); voxels.set(f.voxels, at); at += f.positions.length }
    const json: CollapseJson = { nextId: this.nextId, dirty: [...this.dirty], scanChunk: this.scanChunk, scanCell: this.scanCell,
      fragments: this.fragments.map(f => ({ id: f.id, offset256: f.offset256, vy256: f.vy256, n: f.positions.length })) }
    return { json, arrays: { seeds: Uint32Array.from(seeds), positions, voxels } }
  }

  /** Fragments in flight come back and are announced again as births with no source chunks (nothing to hide). */
  restore(p: Packed): void {
    if (!this.enabled) return
    const j = p.json as CollapseJson
    this.nextId = j.nextId
    for (const s of p.arrays.seeds as Uint32Array) if (!this.seedSet.has(s)) { this.seedSet.add(s); this.seeds.push(s) }
    for (const ci of j.dirty) this.dirty.add(ci)
    this.scanChunk = j.scanChunk
    this.scanCell = j.scanCell
    const pos = p.arrays.positions as Uint32Array, vox = p.arrays.voxels as Uint16Array
    let at = 0
    for (const f of j.fragments) {
      const positions = pos.slice(at, at + f.n), voxels = vox.slice(at, at + f.n)
      at += f.n
      const body: Fragment = { id: f.id, positions, voxels, runs: this.runsOf(positions), offset256: f.offset256, vy256: f.vy256 }
      this.fragments.push(body); this.index(body)
      this.born.push({ id: body.id, positions: positions.slice(), voxels: voxels.slice(), source: [], offset256: body.offset256 })
    }
    this.keepBorn = this.born.length > 0
  }

  mixState(mix: (v: number) => void): void {
    if (!this.enabled) return
    mix(this.nextId); mix(this.scanCap); mix(this.mutationCap); mix(this.fragmentCells); mix(this.maxFragments)
    mix(this.seedSet.size); for (let i = this.seedHead; i < this.seeds.length; i++) mix(this.seeds[i]!)
    mix(this.dirty.size); for (const ci of this.dirty) mix(ci)
    mix(this.scanChunk ?? -1); mix(this.scanCell)
    const s = this.search
    mix(s ? 1 : 0)
    if (s) { mix(s.head); mix(s.cursor); mix(s.remaining); mix(['search', 'supported', 'detach', 'requeue'].indexOf(s.phase)); mix(s.invalid ? 1 : 0); mix(s.usedCache ? 1 : 0); mix(s.queue.length); for (let i = 0; i < s.queue.length; i++) mix(s.queue.data[i]!); for (const [ci, e] of s.epochs) { mix(ci); mix(e) } }
    // Support cache is derived, but affects scheduling. Hash its generation and certificates through a canonical scan.
    this.supportedHash(mix)
    mix(this.fragments.length)
    for (const b of this.fragments) { mix(b.id); mix(b.offset256); mix(b.vy256); mix(b.positions.length); for (let i = 0; i < b.positions.length; i++) { mix(b.positions[i]!); mix(b.voxels[i]!) } }
  }

  private supportedHash(mix: (v: number) => void): void { this.supported.mixState(mix); this.members.mixState(mix) }
  private changed(ci: number): void {
    this.epochs[ci]!++; this.supported.reset()
    if (!this.selfWrite && this.search && (this.search.epochs.has(ci) || this.search.usedCache || this.search.phase === 'supported')) this.search.invalid = true
  }
  private seed(x: number, y: number, z: number): void {
    const L = this.port.layout
    if (x < 0 || y < 0 || z < 0 || x >= L.size[0] || y >= L.size[1] || z >= L.size[2]) return
    if (!this.counts[L.chunkOf(x, y, z)] || this.port.registry.collapses[voxelId(this.port.get(x, y, z))] !== 1) return
    const p = L.voxelIndex(x, y, z)
    if (!this.seedSet.has(p)) { this.seedSet.add(p); this.seeds.push(p) }
  }
  private chunks(positions: Uint32Array, offset = 0, borders = true): ChunkVersion[] {
    const L = this.port.layout, chunks = new Set<number>()
    for (const p of positions) {
      const [x, y0, z] = L.voxelCoords(p), y = y0 + offset
      chunks.add(L.chunkOf(x, y, z))
      if (borders) {
        const xs = (x & 31) === 0 ? [-1, 0] : (x & 31) === 31 ? [0, 1] : [0]
        const ys = (y & 31) === 0 ? [-1, 0] : (y & 31) === 31 ? [0, 1] : [0]
        const zs = (z & 31) === 0 ? [-1, 0] : (z & 31) === 31 ? [0, 1] : [0]
        for (const dx of xs) for (const dy of ys) for (const dz of zs) {
          const cx = (x >> 5) + dx, cy = (y >> 5) + dy, cz = (z >> 5) + dz
          if (L.chunkInBounds(cx, cy, cz)) chunks.add(L.chunkIndex(cx, cy, cz))
        }
      }
    }
    return [...chunks].sort((a, b) => a - b).map(chunk => ({ chunk, version: 0 }))
  }
  private detach(positions: Uint32Array): void {
    const L = this.port.layout, voxels = new Uint16Array(positions.length)
    const source = this.chunks(positions)
    this.port.prepare(this.chunks(positions, 0, false).map(v => v.chunk)); this.port.touch(source.map(v => v.chunk))
    for (let i = 0; i < positions.length; i++) { const [x, y, z] = L.voxelCoords(positions[i]!); voxels[i] = this.port.get(x, y, z) }
    const runs = this.runsOf(positions)
    this.selfWrite = true
    try { for (const p of positions) { const [x, y, z] = L.voxelCoords(p); this.port.write(x, y, z, AIR) } } finally { this.selfWrite = false }
    const body = { id: this.nextId++, positions, voxels, runs, offset256: 0, vy256: 0 }
    this.fragments.push(body); this.index(body)
    this.mutations += positions.length
    this.born.push({ id: body.id, positions: positions.slice(), voxels: voxels.slice(), source })
  }
  /** The vertical runs of a fragment's cells: one per column segment, bottom cell and height. */
  private runsOf(positions: Uint32Array): Run[] {
    const L = this.port.layout, set = new Set(positions), plane = L.size[0] * L.size[2], runs: Run[] = []
    for (const p of positions) {
      if (set.has(p - plane)) continue
      const [x, y, z] = L.voxelCoords(p); let height = 1
      while (set.has(p + height * plane)) height++
      runs.push({ x, y, z, height })
    }
    return runs
  }
  private index(b: Fragment): void {
    for (const r of b.runs) {
      const col = r.x + r.z * this.port.layout.size[0]
      let list = this.occupied.get(col); if (!list) { list = []; this.occupied.set(col, list) }
      list.push({ id: b.id, bottom256: r.y * 256 + b.offset256, top256: (r.y + r.height) * 256 + b.offset256 })
    }
  }
  private unindex(b: Fragment): void {
    for (const r of b.runs) {
      const col = r.x + r.z * this.port.layout.size[0], list = this.occupied.get(col)
      if (!list) continue // multiple disjoint vertical runs may share this column
      for (let i = list.length - 1; i >= 0; i--) if (list[i]!.id === b.id) list.splice(i, 1)
      if (!list.length) this.occupied.delete(col)
    }
  }
  private advance(): void {
    const keep: Fragment[] = [], reg = this.port.registry
    for (const b of this.fragments) {
      b.vy256 = Math.min(MAX_FALL_256, b.vy256 + GRAVITY_256)
      let target = b.offset256 - b.vy256, grid = Number.NEGATIVE_INFINITY, dynamic = Number.NEGATIVE_INFINITY
      for (const r of b.runs) {
        const from = r.y * 256 + b.offset256, to = r.y * 256 + target
        for (let y = Math.ceil(from / 256) - 1; y >= Math.floor(to / 256); y--) {
          if (y < 0) { grid = Math.max(grid, -r.y * 256); break }
          const id = voxelId(this.port.get(r.x, y, r.z))
          if (reg.solid[id] || reg.source[id]) { grid = Math.max(grid, (y + 1 - r.y) * 256); break }
        }
        const other = this.floor(r.x, r.z, from, to, b.id), sand = this.port.fallingFloor(r.x, r.z, from, to)
        if (other !== undefined) dynamic = Math.max(dynamic, other - r.y * 256)
        if (sand !== undefined) dynamic = Math.max(dynamic, sand - r.y * 256)
      }
      target = Math.max(target, grid, dynamic)
      // If an entire landing cannot fit this tick, keep the body at its previous height.
      if (grid >= dynamic && grid >= target && this.mutations + b.positions.length <= this.mutationCap) {
        const offset = grid / 256, chunks = this.chunks(b.positions, offset)
        this.port.prepare(this.chunks(b.positions, offset, false).map(v => v.chunk)); this.port.touch(chunks.map(v => v.chunk))
        this.recordSweep(b, grid)
        this.unindex(b)
        for (let i = 0; i < b.positions.length; i++) { const [x, y, z] = this.port.layout.voxelCoords(b.positions[i]!); this.port.write(x, y + offset, z, b.voxels[i]!) }
        this.landed.push({ id: b.id, offset256: grid, chunks }); this.mutations += b.positions.length
      } else {
        if (grid >= target && grid >= dynamic) target = b.offset256
        if (target > b.offset256 - b.vy256) b.vy256 = 0
        this.recordSweep(b, target)
        this.unindex(b); b.offset256 = target; this.index(b); keep.push(b)
      }
    }
    this.fragments = keep
  }
  private recordSweep(b: Fragment, target: number): void {
    if (!this.port.trackSweeps) return
    for (const r of b.runs) {
      const col = r.x + r.z * this.port.layout.size[0]
      let a = this.swept.get(col); if (!a) { a = []; this.swept.set(col, a) }
      a.push({ lo: r.y * 256 + target, hi: (r.y + r.height) * 256 + b.offset256 })
    }
  }
}
