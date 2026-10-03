import type { BlockRegistry } from '../../blocks/registry.ts'
import { decodeUniform } from '../../world/buffers.ts'
import type { ChunkStore } from '../../world/chunkStore.ts'
import type { Layout } from '../../world/layout.ts'
import { AIR, voxelId, voxelState } from '../../world/voxel.ts'
import { JobReader, type JobRunner } from '../jobs.ts'
import { ActiveQueue } from './activeQueue.ts'
import { FULL, flowGroup, liquidVoxel, volumeOf } from './cell.ts'
import { ChunkBits } from './chunkBits.ts'
import { ContactTable } from './contacts.ts'
import { PoolTable, type Pool } from './pools.ts'
import { FLUID_JOBS, PoolScan, sortSeeds, type ScanComponent } from './scan.ts'
import { SurfaceIndex } from './surfaceIndex.ts'

/** Who wrote a voxel: a command or rule ('external'), the fluid system itself, or gravity. */
export type WriteSource = 'external' | 'fluid' | 'gravity'

export interface FluidOptions {
  /** Ticks between fluid steps. Default 2 (10 Hz at 20 Hz). */
  fluidEvery: number
  /** Active cells processed per fluid step; the rest wait their turn. Default 20 000. */
  fluidCap: number
  /** Units a pool pushes through one outlet or contact face per fluid step. Default 8. */
  outletRate: number
}
export const DEFAULT_FLUID_OPTIONS: FluidOptions = { fluidEvery: 2, fluidCap: 20_000, outletRate: 8 }

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
  protected hadCycle = false
  protected cycleId = 0
  protected readonly settleQueue = new Set<number>()
  protected readonly port: FluidPort
  protected readonly reg: BlockRegistry
  protected readonly layout: Layout
  private readonly pFrom: number[] = []
  private readonly pTo: number[] = []
  private readonly pAmt: number[] = []
  private readonly pGroup: number[] = []

  constructor(port: FluidPort, o: Partial<FluidOptions> = {}) {
    this.port = port
    this.reg = port.registry
    this.layout = port.layout
    this.o = { ...DEFAULT_FLUID_OPTIONS, ...o }
    for (const [k, v] of Object.entries(this.o)) {
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
    if (v === AIR) this.openNear(x, y, z, pos)
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
    const cells = this.active.take(this.o.fluidCap)
    this.pFrom.length = 0; this.pTo.length = 0; this.pAmt.length = 0; this.pGroup.length = 0
    const keep: number[] = []
    for (const pos of cells) {
      const [x, y, z] = this.layout.voxelCoords(pos)
      const v = this.port.get(x, y, z)
      const g = flowGroup(this.reg, v)
      if (g === 0 || this.members.has(x, y, z)) { this.active.drop(pos); continue }
      this.propose(pos, x, y, z, g, volumeOf(this.reg, v))
      keep.push(pos)
    }
    const touched = this.applyProposals()
    for (const pos of keep) {
      if (!this.active.has(pos)) continue
      if (touched.has(pos)) { this.active.requeue(pos); continue }
      if (this.active.rest(pos) >= SLEEP_STEPS) { this.active.drop(pos); this.settleQueue.add(pos) }
      else this.active.requeue(pos)
    }
  }

  /** Down first, then sideways by halving differences of 2 or more; sides that lead to a drop win. */
  protected propose(pos: number, x: number, y: number, z: number, g: number, units: number): void {
    let v = units
    if (y > 0) {
      const room = this.room(x, y - 1, z, g)
      if (room > 0) {
        const t = Math.min(v, room)
        this.offer(pos, this.layout.voxelIndex(x, y - 1, z), t, g)
        v -= t
      }
    }
    if (v < 2) return
    const start = (this.steps + pos) & 3
    const cand: number[] = [], vols: number[] = [], drops: boolean[] = []
    for (let i = 0; i < 4; i++) {
      const s = (start + i) & 3
      const [dx, dz] = SIDES[s]!
      const vn = this.sideVolume(x + dx, y, z + dz, g)
      if (vn < 0 || v - vn < 2) continue
      cand.push(s); vols.push(vn); drops.push(this.leadsToDrop(x, y, z, dx, dz))
    }
    const anyDrop = drops.includes(true)
    for (let k = 0; k < cand.length; k++) {
      if (anyDrop && !drops[k]) continue
      const t = (v - vols[k]!) >> 1
      if (t <= 0) continue
      const [dx, dz] = SIDES[cand[k]!]!
      this.offer(pos, this.layout.voxelIndex(x + dx, y, z + dz), t, g)
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

  /** Applies proposals in order, capped by what the sender still has and the receiver's room; writes each changed cell once. */
  protected applyProposals(): Set<number> {
    const delta = new Map<number, number>()
    const group = new Map<number, number>()
    const units = (pos: number): number => {
      const [x, y, z] = this.layout.voxelCoords(pos)
      return volumeOf(this.reg, this.port.get(x, y, z)) + (delta.get(pos) ?? 0)
    }
    for (let k = 0; k < this.pFrom.length; k++) {
      const f = this.pFrom[k]!, t = this.pTo[k]!, g = this.pGroup[k]!
      const [tx, ty, tz] = this.layout.voxelCoords(t)
      if (this.members.has(tx, ty, tz)) continue
      const tv = this.port.get(tx, ty, tz)
      if (tv !== AIR && flowGroup(this.reg, tv) !== g) continue
      // A cell already claimed this step by another liquid (or sending another liquid) keeps that liquid.
      const gt = group.get(t), gf = group.get(f)
      if ((gt !== undefined && gt !== g) || (gf !== undefined && gf !== g)) continue
      const a = Math.min(this.pAmt[k]!, units(f), FULL - units(t))
      if (a <= 0) continue
      delta.set(f, (delta.get(f) ?? 0) - a)
      delta.set(t, (delta.get(t) ?? 0) + a)
      group.set(f, g)
      group.set(t, g)
    }
    const touched = new Set<number>()
    for (const [pos, d] of delta) {
      if (d === 0) continue
      const [x, y, z] = this.layout.voxelCoords(pos)
      this.port.write(x, y, z, liquidVoxel(group.get(pos)!, volumeOf(this.reg, this.port.get(x, y, z)) + d))
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
    // Fluid-step phases added by Tasks 6–8, in this order:
    // runOutlets, runContacts, runSprings, queueResurfaces, queueSettles
  }

  // ---- rebuild ----

  /** Drops all fluid state and rescans the world: every still body becomes a pool, everything else moves. */
  rebuild(): void {
    this.needsRebuild = false
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
    this.hadCycle = best !== undefined
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
    mix((this.hadCycle ? 1 : 0) | (this.needsRebuild ? 2 : 0))
    this.pools.mixState(mix)
    this.contacts.mixState(mix)
    this.active.mixState(mix)
    mix(this.springs.size)
    for (const s of this.springs) mix(s)
    mix(this.settleQueue.size)
  }
}
