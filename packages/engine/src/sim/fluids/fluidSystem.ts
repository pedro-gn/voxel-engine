import type { BlockRegistry } from '../../blocks/registry.ts'
import { decodeUniform } from '../../world/buffers.ts'
import type { ChunkStore } from '../../world/chunkStore.ts'
import type { Layout } from '../../world/layout.ts'
import { AIR, voxelId, voxelState } from '../../world/voxel.ts'
import { JobReader, type JobRunner } from '../jobs.ts'
import { ActiveQueue } from './activeQueue.ts'
import { FULL, SPRING_RATES, flowGroup, liquidVoxel, volumeOf } from './cell.ts'
import { ChunkBits } from './chunkBits.ts'
import { ContactTable, type Contact } from './contacts.ts'
import { PoolTable, type Pool } from './pools.ts'
import { FLUID_JOBS, PoolScan, sortSeeds, type ScanComponent } from './scan.ts'
import { Resurface } from './resurface.ts'
import { SurfaceIndex } from './surfaceIndex.ts'

/** Who wrote a voxel: a command or rule ('external'), the fluid system itself, or gravity. */
export type WriteSource = 'external' | 'fluid' | 'gravity'

export interface FluidOptions {
  /** Ticks between fluid steps. Default 2 (10 Hz at 20 Hz). */
  fluidEvery: number
  /** Active cells processed per fluid step; the rest wait their turn. Default 4000 (~1.2–1.4 µs per cell in Node: ~5 ms per capped step). */
  fluidCap: number
  /** Units a pool pushes through one outlet or contact face per fluid step. Default 8. */
  outletRate: number
  /** After every fluid step, check every pool invariant (whole world: slow). A violation is logged and the world rescanned. */
  debug: boolean
}
export const DEFAULT_FLUID_OPTIONS: FluidOptions = { fluidEvery: 2, fluidCap: 4000, outletRate: 8, debug: false }

/** What the fluid system needs from the Simulation. */
export interface FluidPort {
  readonly layout: Layout
  readonly registry: BlockRegistry
  readonly store: ChunkStore
  readonly jobs: JobRunner
  readonly epochs: Uint32Array
  get(x: number, y: number, z: number): number
  /** Writes through the simulation as a 'fluid' write (light, rule notifications, write hooks). */
  write(x: number, y: number, z: number, v: number): void
  log(message: string): void
}

export const DX = [1, -1, 0, 0, 0, 0]
export const DY = [0, 0, 1, -1, 0, 0]
export const DZ = [0, 0, 0, 0, 1, -1]
/** Fluid steps without change before a moving cell sleeps (and is offered to a settle scan). */
export const SLEEP_STEPS = 4
/** How far along a side a cell looks for a drop before it prefers that side. */
export const DROP_REACH = 4
/** +x, +z, −x, −z. */
const SIDES: readonly (readonly [number, number])[] = [[1, 0], [0, 1], [-1, 0], [0, -1]]
/** Ascending numeric order for the down-move sort keys. */
const ascending = (a: number, b: number): number => a - b
const SIDE_DX = [1, 0, -1, 0]
const SIDE_DZ = [0, 1, 0, -1]
/** What inlet() did with a moving cell: left it to the automaton, took its step, or left it to the automaton as an outlet a pool refills. */
const INLET = { MOVE: 0, TAKEN: 1, OUTLET: 2 } as const
type InletResult = (typeof INLET)[keyof typeof INLET]

/** Water in the world: moving cells, still pools, springs (spec §4; design notes in the 3a plan). */
export class FluidSystem {
  readonly o: FluidOptions
  readonly index: SurfaceIndex
  readonly members: ChunkBits
  readonly pools: PoolTable
  readonly contacts = new ContactTable()
  readonly active = new ActiveQueue()
  /** Spring positions in the order they appeared. */
  readonly springs = new Set<number>()
  /** Displaced water that found no room (planning deviation 8). Part of the conservation identity. */
  lost = 0
  /** Set by replaceColumns: the next fluid step rescans the world. */
  needsRebuild = false
  /** From the generator's configure(). The cycle pool's surface is seaLevel − 1; 0 means no sea. */
  seaLevel = 0
  protected steps = 0
  protected cycleId = 0
  protected readonly settleQueue = new Set<number>()
  protected readonly port: FluidPort
  protected readonly reg: BlockRegistry
  protected readonly layout: Layout
  private readonly pFrom: number[] = []
  private readonly pTo: number[] = []
  private readonly pAmt: number[] = []
  private readonly pGroup: number[] = []
  /** Down proposals (the sender's full volume), applied before every side proposal, lowest sender first. */
  private readonly dFrom: number[] = []
  private readonly dAmt: number[] = []
  private readonly dGroup: number[] = []
  private readonly dOrder: number[] = []
  // Scratch reused by every fluid step (the automaton allocates nothing per cell).
  private readonly cellsScratch: number[] = []
  private readonly keepScratch: number[] = []
  private readonly adjScratch: Pool[] = []
  private readonly candScratch = new Int32Array(4)
  private readonly volsScratch = new Int32Array(4)
  private readonly dropsScratch = new Uint8Array(4)
  private readonly slotOf = new Map<number, number>()
  private readonly deltas: number[] = []
  private readonly groups: number[] = []
  /** Per touched cell: units it has sent this step (a sender never re-sends what it received this step). */
  private readonly sent: number[] = []
  private readonly touched = new Set<number>()

  constructor(port: FluidPort, o: Partial<FluidOptions> = {}) {
    this.port = port
    this.reg = port.registry
    this.layout = port.layout
    this.o = { ...DEFAULT_FLUID_OPTIONS, ...o }
    for (const k of ['fluidEvery', 'fluidCap', 'outletRate'] as const) {
      const v = this.o[k]
      if (!Number.isInteger(v) || v < 1) throw new RangeError(`fluid option ${k} must be an integer ≥ 1, got ${v}`)
    }
    this.index = new SurfaceIndex(this.layout)
    this.members = new ChunkBits(this.layout)
    this.pools = new PoolTable(this.layout, this.index, this.members)
  }

  get activeCount(): number { return this.active.size }
  get stepCount(): number { return this.steps }
  /** The pool springs draw from, if the world has a sea. */
  get cycle(): Pool | undefined { return this.cycleId === 0 ? undefined : this.pools.get(this.cycleId) }

  poolAt(x: number, y: number, z: number): Pool | undefined { return this.pools.ownerOf(x, y, z) }

  // ---- write hooks ----

  /** Before a voxel changes: the pool owning the cell (its id), or 0. Fluid writes keep their own books. */
  beforeWrite(x: number, y: number, z: number, _old: number, source: WriteSource): number {
    if (source === 'fluid' || !this.members.has(x, y, z)) return 0
    return this.pools.ownerOf(x, y, z)?.id ?? 0
  }

  /** After a voxel changed. `owner` is what beforeWrite returned. */
  afterWrite(x: number, y: number, z: number, old: number, v: number, source: WriteSource, owner: number): void {
    const pos = this.layout.voxelIndex(x, y, z)
    if (this.reg.source[voxelId(old)] === 1) this.springs.delete(pos)
    if (this.reg.source[voxelId(v)] === 1) this.springs.add(pos)
    if (source !== 'fluid') this.external(x, y, z, pos, old, v, owner)
    if (v === AIR) {
      this.openNear(x, y, z, pos)
      this.unsealBelow(x, y, z)
    }
    this.wakeAround(x, y, z)
  }

  /** A command, rule or landing body replaced a liquid cell: keep the pool's books, or push loose water aside. */
  protected external(x: number, y: number, z: number, pos: number, old: number, v: number, owner: number): void {
    if (owner === 0 && this.members.has(x, y, z)) {
      // An orphaned member bit (no pool owns it) must not outlive its water.
      this.members.delete(x, y, z)
      this.pools.capped.delete(pos)
    }
    const g = flowGroup(this.reg, old)
    if (g === 0) return
    const units = volumeOf(this.reg, old)
    const solid = this.reg.solid[voxelId(v)] === 1
    const p = owner !== 0 ? this.pools.get(owner) : undefined
    if (p) {
      this.leave(p, x, y, z, pos, units)
      // Displaced into the pool, unless that was its last surface cell: then the water goes up like loose water.
      if (solid) {
        if (p.area > 0) p.balance += units
        else this.displace(x, y + 1, z, g, units)
      }
      return
    }
    if (solid) this.displace(x, y + 1, z, g, units)
  }

  /** A member cell was overwritten: it leaves its pool, and the member below now tops its column. */
  protected leave(p: Pool, x: number, y: number, z: number, pos: number, units: number): void {
    this.members.delete(x, y, z)
    p.grid -= units
    if (y === p.surfaceY && this.pools.resolve(this.index.get(x, y, z)) === p.id) {
      this.index.delete(x, y, z)
      p.area--
    }
    if (this.pools.capped.delete(pos)) p.capped.delete(pos)
    if (y > 0 && this.members.has(x, y - 1, z)) {
      const below = this.layout.voxelIndex(x, y - 1, z)
      this.pools.capped.set(below, p.id)
      p.capped.add(below)
    }
    if (p.area === 0 && !p.frozen) this.rescan(p)
  }

  /** A cell became air above a pool's surface cell: that pool can rise again. */
  protected unsealBelow(x: number, y: number, z: number): void {
    if (y === 0 || !this.members.has(x, y - 1, z)) return
    const p = this.pools.ownerOf(x, y - 1, z)
    if (p && p.sealed && y - 1 === p.surfaceY) p.sealed = false
  }

  /** A cell became air: each pool touching it at y ≤ its surface gains an outlet there. */
  protected openNear(x: number, y: number, z: number, pos: number): void {
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
      if (!this.members.has(nx, ny, nz)) continue
      const p = this.pools.ownerOf(nx, ny, nz)
      if (p && y <= p.surfaceY) p.outlets.add(pos)
    }
  }

  /** Puts `units` of liquid g pushed out by a solid into the first room up the column (and its sides); the rest is lost. */
  protected displace(x: number, y: number, z: number, g: number, units: number): void {
    let left = units
    const H = this.layout.size[1]
    for (let k = 0; k < FULL && left > 0 && y + k < H; k++) {
      const yy = y + k
      left = this.pour(x, yy, z, g, left)
      for (const [dx, dz] of SIDES) if (left > 0) left = this.pour(x + dx, yy, z + dz, g, left)
      if (left > 0 && this.inside(x, yy, z) && this.reg.solid[voxelId(this.port.get(x, yy, z))] === 1) break // the column is closed above
    }
    if (left > 0) {
      this.lost += left
      this.port.log(`fluids: ${left} displaced units found no room above (${x}, ${y - 1}, ${z})`)
    }
  }

  /** Adds up to `left` units of g at a cell (air, a moving cell of g, or a pool member of g); returns what is left. */
  protected pour(x: number, y: number, z: number, g: number, left: number): number {
    if (!this.inside(x, y, z)) return left
    if (this.members.has(x, y, z)) {
      const p = this.pools.ownerOf(x, y, z)
      if (p && p.liquid === g && this.accepts(p, left)) { p.balance += left; return 0 }
      return left
    }
    const v = this.port.get(x, y, z)
    if (v === AIR) {
      const t = Math.min(left, FULL)
      this.port.write(x, y, z, liquidVoxel(g, t))
      return left - t
    }
    if (flowGroup(this.reg, v) !== g) return left
    const have = volumeOf(this.reg, v)
    const t = Math.min(left, FULL - have)
    if (t > 0) this.port.write(x, y, z, liquidVoxel(g, have + t))
    return left - t
  }

  /** Activates a moving liquid cell (not a pool member) at (x, y, z), if any. */
  wake(x: number, y: number, z: number): void {
    const [sx, sy, sz] = this.layout.size
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return
    if (flowGroup(this.reg, this.port.get(x, y, z)) === 0 || this.members.has(x, y, z)) return
    this.active.add(this.layout.voxelIndex(x, y, z))
  }

  wakeAround(x: number, y: number, z: number): void {
    this.wake(x, y, z)
    for (let d = 0; d < 6; d++) this.wake(x + DX[d]!, y + DY[d]!, z + DZ[d]!)
  }

  inside(x: number, y: number, z: number): boolean {
    const [sx, sy, sz] = this.layout.size
    return x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz
  }

  /** A sealed pool takes water only while it stays below its next level. */
  accepts(p: Pool, t: number): boolean {
    return !p.sealed || p.balance + t < p.area
  }

  // ---- automaton ----

  /** One step for up to fluidCap active cells: every cell proposes from the same snapshot, then proposals apply in order. */
  protected flowCells(): void {
    const cells = this.active.take(this.o.fluidCap, this.cellsScratch)
    this.pFrom.length = 0; this.pTo.length = 0; this.pAmt.length = 0; this.pGroup.length = 0
    this.dFrom.length = 0; this.dAmt.length = 0; this.dGroup.length = 0
    const keep = this.keepScratch
    keep.length = 0
    const sx = this.layout.size[0], layer = this.stride
    for (let i = 0; i < cells.length; i++) {
      const pos = cells[i]!
      const y = Math.floor(pos / layer), rest = pos - y * layer, z = Math.floor(rest / sx), x = rest - z * sx
      const v = this.port.get(x, y, z)
      const g = flowGroup(this.reg, v)
      if (g === 0 || this.members.has(x, y, z)) { this.active.drop(pos); continue }
      const r = this.inlet(pos, x, y, z, g, volumeOf(this.reg, v))
      if (r === INLET.TAKEN) {
        // Joined or absorbed cells left the queue. A cell waiting at a pool's edge stays in line and can still
        // fall asleep, so a pool that cannot fill it never leaves it active forever.
        if (this.active.has(pos)) keep.push(pos)
        continue
      }
      this.propose(pos, x, y, z, g, volumeOf(this.reg, v), r === INLET.OUTLET)
      keep.push(pos)
    }
    const touched = this.applyProposals()
    for (let i = 0; i < keep.length; i++) {
      const pos = keep[i]!
      if (!this.active.has(pos)) continue
      if (touched.has(pos) || this.slotOf.has(pos)) { this.active.requeue(pos); continue } // moved water (even net 0) is awake
      if (this.active.rest(pos) >= SLEEP_STEPS) { this.active.drop(pos); this.settleQueue.add(pos) }
      else this.active.requeue(pos)
    }
  }

  /**
   * Pools owning a face neighbour of (x, y, z), by id. The array is reused by the next call: read it before
   * calling again (inlet does; nothing it calls asks for adjacent pools).
   */
  protected adjacentPools(x: number, y: number, z: number): readonly Pool[] {
    const out = this.adjScratch
    out.length = 0
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
      if (!this.members.has(nx, ny, nz)) continue
      const p = this.pools.ownerOf(nx, ny, nz)
      if (!p || out.includes(p)) continue
      // insertion by id (at most 6 entries)
      let k = out.length
      out.push(p)
      while (k > 0 && out[k - 1]!.id > p.id) { out[k] = out[k - 1]!; k-- }
      out[k] = p
    }
    return out
  }

  /** Resting: the world floor, a pool member, or any block that is neither air nor flowing liquid. */
  protected supported(x: number, y: number, z: number): boolean {
    if (y === 0 || this.members.has(x, y - 1, z)) return true
    const b = this.port.get(x, y - 1, z)
    return b !== AIR && flowGroup(this.reg, b) === 0
  }

  /** A deep cell may join p only with p's water or a ceiling above it (never air or loose water). */
  protected closedAbove(p: Pool, x: number, y: number, z: number): boolean {
    if (this.members.has(x, y + 1, z)) return this.pools.ownerOf(x, y + 1, z) === p
    const a = this.port.get(x, y + 1, z)
    return a !== AIR && flowGroup(this.reg, a) === 0
  }

  protected touches(p: Pool, x: number, y: number, z: number): boolean {
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
      if (this.members.has(nx, ny, nz) && this.pools.ownerOf(nx, ny, nz) === p) return true
    }
    return false
  }

  /**
   * A moving cell next to a pool (design notes: A cell next to a pool). Returns TAKEN when the pool took the
   * cell's step; MOVE or OUTLET (the pool refills the cell after the automaton moves it) lets the automaton move it.
   */
  protected inlet(pos: number, x: number, y: number, z: number, g: number, v: number): InletResult {
    const adj = this.adjacentPools(x, y, z)
    if (adj.length === 0) return INLET.MOVE
    for (const p of adj) {
      if (p.frozen || p.liquid !== g || y !== p.surfaceY + 1) continue
      if (!this.members.has(x, y - 1, z) || this.pools.ownerOf(x, y - 1, z) !== p || !this.accepts(p, v)) continue
      p.balance += v // falling onto the surface
      this.active.drop(pos)
      this.port.write(x, y, z, AIR)
      return INLET.TAKEN
    }
    for (const p of adj) {
      if (p.frozen || p.liquid !== g || y > p.surfaceY) continue
      if (!this.supported(x, y, z)) { p.outlets.add(pos); return INLET.OUTLET }
      if (y === p.surfaceY) {
        const want = p.level + 1
        if (v < want) { p.outlets.add(pos); return INLET.TAKEN }
        if (v > want) {
          if (!this.accepts(p, v - want)) continue
          p.balance += v - want
          this.port.write(x, y, z, liquidVoxel(g, want))
        }
        this.join(p, x, y, z, pos, want)
        return INLET.TAKEN
      }
      if (v === FULL && this.closedAbove(p, x, y, z)) { this.join(p, x, y, z, pos, FULL); return INLET.TAKEN }
      p.outlets.add(pos)
      return INLET.OUTLET
    }
    return INLET.MOVE
  }

  /** A cell becomes a member of p: index or capped entry, then its open neighbours become outlets or contacts. */
  protected join(p: Pool, x: number, y: number, z: number, pos: number, units: number): void {
    this.members.add(x, y, z)
    this.active.drop(pos)
    p.outlets.delete(pos)
    p.grid += units
    if (y === p.surfaceY) {
      p.tiles.add(this.index.set(x, y, z, p.id))
      p.area++
    } else if (!this.members.has(x, y + 1, z)) {
      this.pools.capped.set(pos, p.id)
      p.capped.add(pos)
    }
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
      if (!this.inside(nx, ny, nz) || ny > p.surfaceY) continue
      const npos = this.layout.voxelIndex(nx, ny, nz)
      if (this.members.has(nx, ny, nz)) {
        const q = this.pools.ownerOf(nx, ny, nz)
        if (q && q !== p) this.contacts.add(p.id, pos, q.id, npos)
        continue
      }
      const nv = this.port.get(nx, ny, nz)
      if (nv === AIR) p.outlets.add(npos)
      else if (flowGroup(this.reg, nv) === p.liquid) this.active.add(npos)
    }
  }

  /** Each pool fills its outlets once (design notes: Outlets), debiting its balance. */
  protected runOutlets(): void {
    for (const p of this.pools.all()) {
      if (p.frozen) continue
      for (const o of [...p.outlets]) {
        const [x, y, z] = this.layout.voxelCoords(o)
        if (y > p.surfaceY || this.members.has(x, y, z) || !this.touches(p, x, y, z)) { p.outlets.delete(o); continue }
        const v = this.port.get(x, y, z)
        const g = flowGroup(this.reg, v)
        if (v !== AIR && g !== p.liquid) { p.outlets.delete(o); continue }
        const have = g === 0 ? 0 : volumeOf(this.reg, v)
        let target = FULL
        if (y === p.surfaceY) {
          target = p.level + 1
          const onMember = this.members.has(x, y - 1, z) && this.pools.ownerOf(x, y - 1, z) === p
          if (!onMember && p.level < have + 1) { p.outlets.delete(o); continue }
        }
        const t = Math.min(target - have, this.o.outletRate, p.grid + p.balance)
        if (t <= 0) continue
        p.balance -= t
        this.port.write(x, y, z, liquidVoxel(p.liquid, have + t))
      }
    }
  }

  /** Cells that fell asleep this step: one settle scan from their column tops. */
  protected queueSettles(): void {
    if (this.settleQueue.size === 0) return
    const tops: number[] = []
    const seen = new Set<number>()
    const H = this.layout.size[1]
    for (const pos of this.settleQueue) {
      const [x, y0, z] = this.layout.voxelCoords(pos)
      const g = flowGroup(this.reg, this.port.get(x, y0, z))
      if (g === 0 || this.members.has(x, y0, z)) continue
      let y = y0
      while (y + 1 < H && !this.members.has(x, y + 1, z) && flowGroup(this.reg, this.port.get(x, y + 1, z)) === g) y++
      const top = this.layout.voxelIndex(x, y, z)
      if (this.active.has(top) || seen.has(top)) continue
      seen.add(top)
      tops.push(top)
    }
    this.settleQueue.clear()
    if (tops.length === 0) return
    this.port.jobs.start(new PoolScan({
      kind: 'settle', registry: this.reg, layout: this.layout, seeds: sortSeeds(this.layout, tops),
      claimable: (x, y, z, pos) => !this.members.has(x, y, z) && !this.active.has(pos),
      onFinish: (cs) => this.finishSettle(cs),
    }))
  }

  /** Installs settled bodies. A body with a cell that joined a pool meanwhile (joins write nothing, so the job did not go stale) is retried later. */
  protected finishSettle(cs: readonly ScanComponent[]): void {
    const fresh: ScanComponent[] = []
    for (const c of cs) {
      const cells = [...c.surface, ...c.deep]
      const clash = cells.some((pos) => { const [x, y, z] = this.layout.voxelCoords(pos); return this.members.has(x, y, z) })
      if (clash) { for (const pos of cells) this.settleQueue.add(pos) }
      else fresh.push(c)
    }
    this.install(fresh)
  }

  // ---- resurfacing ----

  /** Every pool whose balance reached a whole level gets a resurface job (a sealed full pool cannot rise). */
  protected queueResurfaces(): void {
    for (const p of this.pools.all()) {
      if (p.frozen || p.area === 0) continue
      const up = p.balance >= p.area
      if (!up && p.balance > -p.area) continue
      if (up && p.level === 7 && p.sealed) continue
      this.resurface(p)
    }
  }

  protected resurface(p: Pool): void {
    p.frozen = true
    this.port.jobs.start(new Resurface({
      poolId: p.id, pools: this.pools, index: this.index, layout: this.layout,
      apply: (id, cells) => this.applyResurface(id, cells),
    }))
  }

  private get stride(): number { return this.layout.size[0] * this.layout.size[2] }

  private isSurfaceOf(p: Pool, pos: number): boolean {
    const [x, y, z] = this.layout.voxelCoords(pos)
    return y === p.surfaceY && this.members.has(x, y, z) && this.pools.resolve(this.index.get(x, y, z)) === p.id &&
      flowGroup(this.reg, this.port.get(x, y, z)) === p.liquid
  }

  /** Rewrites a pool's surface: normalise levels, then whole levels and layers while the balance allows. */
  applyResurface(id: number, cells: number[]): void {
    const p = this.pools.get(id)
    if (!p) return
    p.frozen = false
    let live = cells.filter((pos) => this.isSurfaceOf(p, pos))
    for (const pos of live) {
      const [x, y, z] = this.layout.voxelCoords(pos)
      const u = volumeOf(this.reg, this.port.get(x, y, z))
      if (u === p.level + 1) continue
      this.port.write(x, y, z, liquidVoxel(p.liquid, p.level + 1))
      p.grid += p.level + 1 - u
      p.balance -= p.level + 1 - u
    }
    p.area = live.length
    while (p.area > 0) {
      if (p.balance >= p.area) {
        if (p.level < 7) { this.setLevel(p, live, p.level + Math.min(7 - p.level, Math.floor(p.balance / p.area))); continue }
        const above = this.layerAbove(live)
        if (above.length === 0) { p.sealed = true; break }
        live = this.raiseLayer(p, live, above)
        continue
      }
      if (p.balance <= -p.area) {
        if (p.level > 0) { this.setLevel(p, live, p.level - Math.min(p.level, Math.floor(-p.balance / p.area))); continue }
        this.dropLayer(p, live)
        return
      }
      break
    }
    if (p.area === 0) this.rescan(p)
  }

  private setLevel(p: Pool, live: readonly number[], level: number): void {
    const d = level - p.level
    p.level = level
    if (d < 0) p.sealed = false
    for (const pos of live) {
      const [x, y, z] = this.layout.voxelCoords(pos)
      this.port.write(x, y, z, liquidVoxel(p.liquid, level + 1))
    }
    p.grid += d * live.length
    p.balance -= d * live.length
    if (d > 0) this.surfaceOutlets(p, live)
  }

  private layerAbove(live: readonly number[]): number[] {
    const H = this.layout.size[1]
    return live.map((pos) => pos + this.stride).filter((a) => {
      const [x, y, z] = this.layout.voxelCoords(a)
      return y < H && this.port.get(x, y, z) === AIR
    })
  }

  /** A full pool rises: level-0 cells on the air above its surface; old surface cells under a ceiling become capped tops. */
  private raiseLayer(p: Pool, old: readonly number[], above: number[]): number[] {
    const up = new Set(above)
    for (const pos of old) {
      const [x, y, z] = this.layout.voxelCoords(pos)
      this.index.delete(x, y, z)
      if (!up.has(pos + this.stride)) { this.pools.capped.set(pos, p.id); p.capped.add(pos) }
    }
    p.tiles.clear()
    p.surfaceY++
    p.level = 0
    p.area = above.length
    for (const pos of above) {
      const [x, y, z] = this.layout.voxelCoords(pos)
      this.members.add(x, y, z)
      p.tiles.add(this.index.set(x, y, z, p.id))
      this.port.write(x, y, z, liquidVoxel(p.liquid, 1))
    }
    p.grid += above.length
    p.balance -= above.length
    this.surfaceOutlets(p, above)
    return above
  }

  /** Air or moving water beside surface cells: outlets. Another pool's member: a contact. */
  private surfaceOutlets(p: Pool, cells: readonly number[]): void {
    for (const pos of cells) {
      const [x, y, z] = this.layout.voxelCoords(pos)
      for (const [dx, dz] of SIDES) {
        const nx = x + dx, nz = z + dz
        if (!this.inside(nx, y, nz)) continue
        const npos = this.layout.voxelIndex(nx, y, nz)
        if (this.members.has(nx, y, nz)) {
          const q = this.pools.ownerOf(nx, y, nz)
          if (q && q !== p) this.contacts.add(p.id, pos, q.id, npos)
          continue
        }
        const v = this.port.get(nx, y, nz)
        if (v === AIR || flowGroup(this.reg, v) === p.liquid) p.outlets.add(npos)
      }
    }
  }

  /**
   * A level-0 surface empties: remove it (one unit per cell goes to the balance) and rescan what is left below.
   * Each member left under a removed cell becomes a capped top of p, so p (frozen) keeps owning its cells
   * until its own split finishes: another pool's split in flight cannot claim them as ownerless.
   */
  private dropLayer(p: Pool, live: readonly number[]): void {
    for (const pos of live) {
      const [x, y, z] = this.layout.voxelCoords(pos)
      this.members.delete(x, y, z)
      this.index.delete(x, y, z)
      this.port.write(x, y, z, AIR)
      if (y > 0 && this.members.has(x, y - 1, z)) {
        const seed = pos - this.stride
        this.pools.capped.set(seed, p.id)
        p.capped.add(seed)
      }
    }
    p.grid -= live.length
    p.balance += live.length
    p.area = 0
    p.tiles.clear()
    this.split(p, []) // the seeds are among p's capped tops now
  }

  /** Rescans what is left of p from `extra` seeds and its capped tops. p stays frozen until finishSplit replaces it. */
  protected split(p: Pool, extra: readonly number[]): void {
    p.frozen = true
    this.port.jobs.start(new PoolScan({
      kind: 'split', registry: this.reg, layout: this.layout, seeds: sortSeeds(this.layout, [...extra, ...p.capped]),
      claimable: (x, y, z) => {
        if (!this.members.has(x, y, z)) return false
        const o = this.pools.ownerOf(x, y, z)
        return o === undefined || o === p
      },
      onFinish: (cs) => this.finishSplit(p.id, cs),
    }))
  }

  /** A pool that lost its whole surface (commands) is rescanned like a layer drop. */
  protected rescan(p: Pool): void { this.split(p, []) }

  /** Replaces the old pool with the scan's parts; its balance is shared by grid volume (the remainder to the largest). */
  protected finishSplit(id: number, cs: readonly ScanComponent[]): void {
    const p = this.pools.get(id)
    if (!p) return
    for (const c of p.capped) this.pools.capped.delete(c)
    this.pools.remove(p)
    const made = this.install(cs)
    if (made.length === 0) {
      if (p.balance !== 0) this.port.log(`fluids: pool ${p.id} emptied with ${p.balance} units unplaced`)
      this.lost += p.balance
      if (p.cycle) this.cycleId = 0
      return
    }
    const total = made.reduce((s, q) => s + q.grid, 0)
    const byGrid = [...made].sort((a, b) => b.grid - a.grid || a.id - b.id)
    let given = 0
    for (const q of byGrid) {
      const share = total === 0 ? 0 : Math.trunc((p.balance * q.grid) / total)
      q.balance += share
      given += share
    }
    byGrid[0]!.balance += p.balance - given
    if (p.cycle) {
      const big = [...made].sort((a, b) => b.area - a.area || a.id - b.id)[0]!
      big.cycle = true
      this.cycleId = big.id
    }
  }

  // ---- contacts ----

  protected ownedBy(pos: number, p: Pool): boolean {
    const [x, y, z] = this.layout.voxelCoords(pos)
    return this.members.has(x, y, z) && this.pools.ownerOf(x, y, z) === p
  }

  /** What a contact would do this step, by exact heights; the single source for runContacts and contactsPending. */
  private contactStep(c: Contact): { kind: 'drop' } | { kind: 'wait' } | { kind: 'merge'; a: Pool; b: Pool } | { kind: 'move'; hi: Pool; lo: Pool; t: number } {
    const a = this.pools.get(c.a), b = this.pools.get(c.b)
    if (!a || !b || a === b) return { kind: 'drop' }
    if (a.frozen || b.frozen || a.area === 0 || b.area === 0) return { kind: 'wait' }
    let faces = 0
    for (const [fa, fb] of c.faces) if (this.ownedBy(fa, a) && this.ownedBy(fb, b)) faces++
    if (faces === 0) return { kind: 'drop' }
    const ha = (a.surfaceY * 8 + a.level) * a.area + a.balance
    const hb = (b.surfaceY * 8 + b.level) * b.area + b.balance
    const d = ha * b.area - hb * a.area
    const [hi, lo] = d >= 0 ? [a, b] : [b, a]
    const tMax = Math.floor(Math.abs(d) / (a.area + b.area))
    if (tMax === 0) return a.surfaceY === b.surfaceY ? { kind: 'merge', a, b } : { kind: 'wait' }
    let t = Math.min(tMax, this.o.outletRate * faces, hi.grid + hi.balance)
    if (lo.sealed) t = Math.min(t, lo.area - 1 - lo.balance)
    return t > 0 ? { kind: 'move', hi, lo, t } : { kind: 'wait' }
  }

  /**
   * Touching pools trade water from the higher to the lower by exact heights,
   * H = (surfaceY·8 + level)·area + balance, at most outletRate per live face. Equal pools on one layer merge.
   */
  protected runContacts(): void {
    for (const c of this.contacts.all()) {
      const r = this.contactStep(c)
      if (r.kind === 'drop') this.contacts.delete(c)
      else if (r.kind === 'merge') this.merge(r.a, r.b)
      else if (r.kind === 'move') { r.hi.balance -= r.t; r.lo.balance += r.t }
    }
  }

  /** Folds the higher id into the lower; a resurface job evens the levels if they differed. */
  protected merge(a: Pool, b: Pool): void {
    const [into, from] = a.id < b.id ? [a, b] : [b, a]
    const level = into.area >= from.area ? into.level : from.level
    const relevel = into.level !== from.level
    this.pools.merge(into, from)
    into.level = level
    if (into.cycle) this.cycleId = into.id
    if (relevel) this.resurface(into)
  }

  // ---- springs ----

  /**
   * Each spring pushes its rate into the cells below and beside it (air, moving water, or another pool's
   * balance), at most FULL per cell. In a world with a sea level, what it gives is debited from the sea, so total
   * volume never changes; with no sea pool (gone, or never generated) springs give nothing. Only a world
   * with no sea level (seaLevel 0) has infinite springs.
   */
  protected runSprings(): void {
    const cycle = this.cycle
    for (const s of [...this.springs]) {
      const [x, y, z] = this.layout.voxelCoords(s)
      const v = this.port.get(x, y, z)
      if (this.reg.source[voxelId(v)] !== 1) { this.springs.delete(s); continue }
      const g = this.reg.liquidGroup[voxelId(v)]!
      let left = SPRING_RATES[voxelState(v)]!
      if (this.seaLevel > 0) left = cycle ? Math.min(left, Math.max(0, cycle.grid + cycle.balance)) : 0
      let given = 0
      const start = (this.steps + s) & 3
      const order: [number, number, number][] = [[0, -1, 0]]
      for (let i = 0; i < 4; i++) { const [dx, dz] = SIDES[(start + i) & 3]!; order.push([dx, 0, dz]) }
      for (const [dx, dy, dz] of order) {
        if (left <= 0) break
        const nx = x + dx, ny = y + dy, nz = z + dz
        if (!this.inside(nx, ny, nz)) continue
        if (this.members.has(nx, ny, nz)) {
          const q = this.pools.ownerOf(nx, ny, nz)
          if (!q || q === cycle || q.liquid !== g) continue
          const t = Math.min(left, FULL)
          if (!this.accepts(q, t)) continue
          q.balance += t
          left -= t
          given += t
          continue
        }
        const nv = this.port.get(nx, ny, nz)
        if (nv === AIR) {
          const t = Math.min(left, FULL)
          this.port.write(nx, ny, nz, liquidVoxel(g, t))
          left -= t
          given += t
        } else if (flowGroup(this.reg, nv) === g) {
          const have = volumeOf(this.reg, nv)
          const t = Math.min(left, FULL - have)
          if (t > 0) {
            this.port.write(nx, ny, nz, liquidVoxel(g, have + t))
            left -= t
            given += t
          }
        }
      }
      if (cycle && given > 0) cycle.balance -= given
    }
  }

  /** Test/debug hook: true while some contact would still move water or merge on the next step. */
  contactsPending(): boolean {
    return this.contacts.all().some((c) => { const k = this.contactStep(c).kind; return k === 'merge' || k === 'move' })
  }

  /** Every pool-invariant violation (design notes: Members and ownership). Whole-world: tests and debug builds only. */
  checkInvariants(): string[] {
    const out: string[] = []
    const grid = new Map<number, number>()
    const area = new Map<number, number>()
    this.forEachLiquid((x, y, z, _pos, v) => {
      if (!this.members.has(x, y, z)) return
      const p = this.pools.ownerOf(x, y, z)
      if (!p) { out.push(`member (${x}, ${y}, ${z}) has no owner`); return }
      if (p.frozen) return // a pending job may legitimately leave a frozen pool's cells out of date
      if (flowGroup(this.reg, v) !== p.liquid) { out.push(`member (${x}, ${y}, ${z}) is not pool ${p.id}'s liquid`); return }
      const u = volumeOf(this.reg, v)
      grid.set(p.id, (grid.get(p.id) ?? 0) + u)
      if (y > p.surfaceY) out.push(`member (${x}, ${y}, ${z}) is above pool ${p.id}'s surface ${p.surfaceY}`)
      else if (y === p.surfaceY && this.pools.resolve(this.index.get(x, y, z)) === p.id) {
        area.set(p.id, (area.get(p.id) ?? 0) + 1)
        if (u !== p.level + 1) out.push(`surface (${x}, ${y}, ${z}) holds ${u}, pool ${p.id} is at level ${p.level}`)
      } else if (y < p.surfaceY && u !== FULL) out.push(`deep (${x}, ${y}, ${z}) of pool ${p.id} holds ${u}`)
    })
    for (const p of this.pools.all()) {
      if (p.frozen) continue
      if ((grid.get(p.id) ?? 0) !== p.grid) out.push(`pool ${p.id} grid ${p.grid}, cells hold ${grid.get(p.id) ?? 0}`)
      if ((area.get(p.id) ?? 0) !== p.area) out.push(`pool ${p.id} area ${p.area}, surface cells ${area.get(p.id) ?? 0}`)
      if (p.grid + p.balance < 0) out.push(`pool ${p.id} has negative volume ${p.grid + p.balance}`)
    }
    return out
  }

  /**
   * Down first, then sideways by halving differences of 2 or more; sides that lead to a drop win. `outlet`: a pool
   * refills the cell this step (inlet() registered it as an outlet).
   */
  protected propose(pos: number, x: number, y: number, z: number, g: number, units: number, outlet = false): void {
    let v = units
    if (y > 0) {
      // A valid target below takes the whole cell: the cell below may itself be moving down this step, and down
      // moves apply first, bottom-up, so a falling column stays contiguous. Side moves keep the snapshot room.
      const below = this.sideVolume(x, y - 1, z, g)
      if (below >= 0) {
        this.dFrom.push(pos); this.dAmt.push(units); this.dGroup.push(g)
        // Water below that took part in a move last step is still falling: wait for the column to move on instead of
        // shedding sideways mid-air (which punches holes that the whole-column move then carries down). `slotOf` still
        // holds the previous step's moved cells here (senders and receivers, also those whose net change is 0). A
        // column that stays blocked stops changing and spreads as before. A pool's outlet never waits: its pool
        // refills what it sheds, so no hole opens, and a lip that waited whenever the cell below fed the fall beside it
        // would feed that fall in pulses (holes sliding down it).
        if (below > 0 && !outlet && this.slotOf.has(pos - this.stride)) return
        v -= Math.min(v, FULL - below)
      }
    }
    if (v < 2) return
    const start = (this.steps + pos) & 3
    const cand = this.candScratch, vols = this.volsScratch, drops = this.dropsScratch
    let n = 0, anyDrop = false
    for (let i = 0; i < 4; i++) {
      const s = (start + i) & 3
      const dx = SIDE_DX[s]!, dz = SIDE_DZ[s]!
      const vn = this.sideVolume(x + dx, y, z + dz, g)
      if (vn < 0 || v - vn < 2) continue
      const drop = this.leadsToDrop(x, y, z, dx, dz)
      cand[n] = s; vols[n] = vn; drops[n] = drop ? 1 : 0
      anyDrop ||= drop
      n++
    }
    for (let k = 0; k < n; k++) {
      if (anyDrop && drops[k] === 0) continue
      const t = (v - vols[k]!) >> 1
      if (t <= 0) continue
      const s = cand[k]!
      this.offer(pos, this.layout.voxelIndex(x + SIDE_DX[s]!, y, z + SIDE_DZ[s]!), t, g)
      v -= t
    }
  }

  private offer(from: number, to: number, amount: number, g: number): void {
    this.pFrom.push(from); this.pTo.push(to); this.pAmt.push(amount); this.pGroup.push(g)
  }

  /** Room for liquid g: air takes FULL, a moving cell of g what it lacks; members, solids and other liquids none. */
  protected room(x: number, y: number, z: number, g: number): number {
    if (!this.inside(x, y, z) || this.members.has(x, y, z)) return 0
    const v = this.port.get(x, y, z)
    if (v === AIR) return FULL
    return flowGroup(this.reg, v) === g ? FULL - volumeOf(this.reg, v) : 0
  }

  /** A side's current units (air = 0), or −1 when water cannot go there. */
  protected sideVolume(x: number, y: number, z: number, g: number): number {
    if (!this.inside(x, y, z) || this.members.has(x, y, z)) return -1
    const v = this.port.get(x, y, z)
    if (v === AIR) return 0
    return flowGroup(this.reg, v) === g ? volumeOf(this.reg, v) : -1
  }

  /** True if walking up to DROP_REACH cells of air along (dx, dz) reaches a cell with air below. */
  protected leadsToDrop(x: number, y: number, z: number, dx: number, dz: number): boolean {
    if (y === 0) return false
    for (let k = 1; k <= DROP_REACH; k++) {
      const nx = x + dx * k, nz = z + dz * k
      if (!this.inside(nx, y, nz) || this.port.get(nx, y, nz) !== AIR) return false
      if (this.port.get(nx, y - 1, nz) === AIR) return true
    }
    return false
  }

  /** Applies one move, capped by the sender's send budget (snapshot units minus units already sent this step) and the receiver's room (per-step deltas included). */
  private applyMove(f: number, t: number, g: number, amount: number, sx: number, layer: number): void {
    const slot = this.slotOf, delta = this.deltas, group = this.groups, sent = this.sent
    const ty = Math.floor(t / layer), tr = t - ty * layer, tz = Math.floor(tr / sx), tx = tr - tz * sx
    if (this.members.has(tx, ty, tz)) return
    const tv = this.port.get(tx, ty, tz)
    if (tv !== AIR && flowGroup(this.reg, tv) !== g) return
    // A cell already claimed this step by another liquid (or sending another liquid) keeps that liquid.
    const st = slot.get(t), sf = slot.get(f)
    if ((st !== undefined && group[st] !== g) || (sf !== undefined && group[sf] !== g)) return
    const fy = Math.floor(f / layer), fr = f - fy * layer, fz = Math.floor(fr / sx), fx = fr - fz * sx
    const snap = volumeOf(this.reg, this.port.get(fx, fy, fz))
    const budget = snap - (sf === undefined ? 0 : sent[sf]!) // water received this step is never re-sent
    const ut = volumeOf(this.reg, tv) + (st === undefined ? 0 : delta[st]!)
    const a = Math.min(amount, budget, FULL - ut) // budget <= current units, so the sender cannot go negative
    if (a <= 0) return
    if (sf === undefined) { slot.set(f, delta.length); delta.push(-a); group.push(g); sent.push(a) } else { delta[sf] = delta[sf]! - a; sent[sf] = sent[sf]! + a }
    if (st === undefined) { slot.set(t, delta.length); delta.push(a); group.push(g); sent.push(0) } else delta[st] = delta[st]! + a
  }

  /**
   * Applies every down proposal first (lowest sender first, ties by proposal order), then the side proposals in
   * order, each capped by the sender's send budget (its snapshot water, never what it received this step) and the receiver's room; writes each changed cell once, in the
   * order cells were first touched. Returns the written cells (a set reused by the next call).
   */
  protected applyProposals(): Set<number> {
    // Per touched cell, in first-touch order: its slot in the parallel delta/group arrays.
    const slot = this.slotOf, delta = this.deltas, group = this.groups
    slot.clear(); delta.length = 0; group.length = 0; this.sent.length = 0
    const sx = this.layout.size[0], layer = this.stride
    // Sort key: sender y, then proposal index (a total order, so any sort gives the same result). The index field
    // is 24 bits: down proposals number at most fluidCap (4000 by default), far below 2^24.
    const order = this.dOrder
    order.length = 0
    for (let k = 0; k < this.dFrom.length; k++) order.push(Math.floor(this.dFrom[k]! / layer) * 0x1000000 + k)
    order.sort(ascending)
    for (let i = 0; i < order.length; i++) {
      const k = order[i]! % 0x1000000, f = this.dFrom[k]!
      this.applyMove(f, f - layer, this.dGroup[k]!, this.dAmt[k]!, sx, layer)
    }
    for (let k = 0; k < this.pFrom.length; k++) this.applyMove(this.pFrom[k]!, this.pTo[k]!, this.pGroup[k]!, this.pAmt[k]!, sx, layer)
    const touched = this.touched
    touched.clear()
    for (const [pos, i] of slot) {
      const d = delta[i]!
      if (d === 0) continue
      const y = Math.floor(pos / layer), r = pos - y * layer, z = Math.floor(r / sx), x = r - z * sx
      this.port.write(x, y, z, liquidVoxel(group[i]!, volumeOf(this.reg, this.port.get(x, y, z)) + d))
      touched.add(pos)
    }
    return touched
  }

  // ---- step ----

  step(tick: number): void {
    if (this.needsRebuild) this.rebuild()
    if (tick % this.o.fluidEvery !== 0) return
    this.steps++
    this.flowCells()
    this.runOutlets()
    this.runContacts()
    this.runSprings()
    this.queueResurfaces()
    this.queueSettles()
    if (this.o.debug) {
      const bad = this.checkInvariants()
      if (bad.length > 0) {
        this.port.log(`fluids: invariant check failed (${bad.length}): ${bad.slice(0, 3).join('; ')}; rescanning`)
        this.needsRebuild = true
      }
    }
  }

  // ---- rebuild ----

  /**
   * Whether regenerating chunk ci from `before` to `after` can touch fluid state, so the world needs a
   * rescan: liquid or pool members in it before, liquid in it after, or liquid on a neighbouring chunk's
   * face against it (a pool or moving water whose wall or floor just changed). Reads the store, so call it
   * before writing any of the regenerated chunks.
   */
  regenTouches(ci: number, before: Uint16Array, after: Uint16Array): boolean {
    const liquid = this.reg.liquid
    if (this.members.anyInChunk(ci)) return true
    for (let i = 0; i < before.length; i++) if (liquid[voxelId(before[i]!)] === 1 || liquid[voxelId(after[i]!)] === 1) return true
    const L = this.layout, store = this.port.store
    const [cx, cy, cz] = L.chunkCoords(ci)
    for (let d = 0; d < 6; d++) {
      const nx = cx + DX[d]!, ny = cy + DY[d]!, nz = cz + DZ[d]!
      if (!L.chunkInBounds(nx, ny, nz)) continue
      const e = store.table[L.chunkIndex(nx, ny, nz)]!
      if (e < 0) { if (liquid[voxelId(decodeUniform(e))] === 1) return true; continue }
      // the neighbour's face against ci: its local coordinate on the axis of d is 0 (d positive) or 31
      const vox = store.views.voxels(e), at = DX[d]! + DY[d]! + DZ[d]! > 0 ? 0 : 31
      for (let a = 0; a < 32; a++) for (let b = 0; b < 32; b++) {
        const i = DX[d] !== 0 ? at + (a << 5) + (b << 10) : DY[d] !== 0 ? a + (b << 5) + (at << 10) : a + (at << 5) + (b << 10)
        if (liquid[voxelId(vox[i]!)] === 1) return true
      }
    }
    return false
  }

  /** Drops all fluid state and rescans the world: every still body becomes a pool, everything else moves. */
  rebuild(): void {
    this.needsRebuild = false
    let unplaced = 0
    for (const p of this.pools.all()) unplaced += p.balance
    if (unplaced !== 0) {
      this.port.log(`fluids: rebuild dropped ${unplaced} unplaced balance units`)
      this.lost += unplaced
    }
    this.pools.clear(); this.index.clear(); this.members.clear(); this.contacts.clear()
    this.active.clear(); this.springs.clear(); this.settleQueue.clear()
    this.port.jobs.cancel((j) => FLUID_JOBS.has(j.kind))
    const seeds: number[] = []
    this.forEachLiquid((x, y, z, pos, v) => {
      if (this.reg.source[voxelId(v)] === 1) { this.springs.add(pos); return }
      const g = flowGroup(this.reg, v)
      if (flowGroup(this.reg, this.port.get(x, y + 1, z)) !== g) seeds.push(pos)
    })
    const scan = new PoolScan({
      kind: 'rebuild', registry: this.reg, layout: this.layout, seeds: sortSeeds(this.layout, seeds),
      claimable: (x, y, z) => !this.members.has(x, y, z),
      onFinish: (cs) => { this.install(cs) },
    })
    scan.step(new JobReader(this.layout, this.port.epochs, (x, y, z) => this.port.get(x, y, z)), Infinity)
    scan.finish()
    this.forEachLiquid((x, y, z, pos, v) => {
      if (flowGroup(this.reg, v) !== 0 && !this.members.has(x, y, z)) this.active.add(pos)
    })
    this.pickCycle()
  }

  /** Creates a pool per component: index, member bits, capped tops, outlets; then links edges (contacts or wake-ups). */
  install(cs: readonly ScanComponent[]): Pool[] {
    const out: Pool[] = []
    for (const c of cs) {
      const p = this.pools.create(c.liquid, c.surfaceY, c.level)
      p.area = c.surface.length
      p.grid = c.grid
      for (const pos of c.surface) {
        const [x, y, z] = this.layout.voxelCoords(pos)
        this.members.add(x, y, z)
        p.tiles.add(this.index.set(x, y, z, p.id))
      }
      for (const pos of c.deep) {
        const [x, y, z] = this.layout.voxelCoords(pos)
        this.members.add(x, y, z)
      }
      for (const pos of c.capped) { this.pools.capped.set(pos, p.id); p.capped.add(pos) }
      for (const pos of c.outlets) p.outlets.add(pos)
      out.push(p)
    }
    cs.forEach((c, k) => { for (const [own, other] of c.edges) this.link(out[k]!, own, other) })
    return out
  }

  /** A same-liquid neighbour of pool p's cell `own`: a contact if another pool owns it, else it moves. */
  protected link(p: Pool, own: number, other: number): void {
    const [x, y, z] = this.layout.voxelCoords(other)
    if (this.members.has(x, y, z)) {
      const q = this.pools.ownerOf(x, y, z)
      if (q && q !== p) this.contacts.add(p.id, own, q.id, other)
      return
    }
    this.wake(x, y, z)
  }

  /** The cycle pool is the largest pool at the sea's surface (seaLevel − 1). */
  protected pickCycle(): void {
    this.cycleId = 0
    let best: Pool | undefined
    if (this.seaLevel > 0) {
      for (const p of this.pools.all()) if (p.surfaceY === this.seaLevel - 1 && (!best || p.area > best.area)) best = p
    }
    if (best) { best.cycle = true; this.cycleId = best.id }
  }

  /** Every liquid voxel (springs included), chunk by chunk in index order. Reads the store directly: fast enough for a whole-world pass. */
  protected forEachLiquid(fn: (x: number, y: number, z: number, pos: number, v: number) => void): void {
    const L = this.layout, store = this.port.store, liquid = this.reg.liquid
    for (let ci = 0; ci < L.chunkCount; ci++) {
      const e = store.table[ci]!
      const uniform = e < 0 ? decodeUniform(e) : -1
      if (uniform >= 0 && liquid[voxelId(uniform)] !== 1) continue
      const vox = uniform >= 0 ? null : store.views.voxels(e)
      const [cx, cy, cz] = L.chunkCoords(ci)
      for (let i = 0; i < 32768; i++) {
        const v = vox ? vox[i]! : uniform
        if (liquid[v & 0xfff] !== 1) continue
        const x = cx * 32 + (i & 31), z = cz * 32 + ((i >> 5) & 31), y = cy * 32 + (i >> 10)
        fn(x, y, z, L.voxelIndex(x, y, z), v)
      }
    }
  }

  /** Exact liquid units: every flowing cell, plus pool balances, plus lost. Springs are not counted. */
  totalVolume(): number {
    let n = this.lost
    for (const p of this.pools.all()) n += p.balance
    this.forEachLiquid((_x, _y, _z, _pos, v) => {
      if (this.reg.source[voxelId(v)] !== 1) n += (voxelState(v) & 7) + 1
    })
    return n
  }

  mixState(mix: (v: number) => void): void {
    mix(this.steps); mix(this.lost); mix(this.seaLevel); mix(this.cycleId)
    mix(this.needsRebuild ? 2 : 0)
    this.pools.mixState(mix)
    this.contacts.mixState(mix)
    this.active.mixState(mix)
    mix(this.springs.size)
    for (const s of this.springs) mix(s)
    mix(this.settleQueue.size)
  }
}
