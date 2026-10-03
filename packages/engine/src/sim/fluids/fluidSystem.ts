import type { BlockRegistry } from '../../blocks/registry.ts'
import { decodeUniform } from '../../world/buffers.ts'
import type { ChunkStore } from '../../world/chunkStore.ts'
import type { Layout } from '../../world/layout.ts'
import { AIR, voxelId, voxelState } from '../../world/voxel.ts'
import { JobReader, type JobRunner } from '../jobs.ts'
import { ActiveQueue } from './activeQueue.ts'
import { flowGroup, volumeOf } from './cell.ts'
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
  afterWrite(x: number, y: number, z: number, old: number, v: number, _source: WriteSource, _owner: number): void {
    const pos = this.layout.voxelIndex(x, y, z)
    if (this.reg.source[voxelId(old)] === 1) this.springs.delete(pos)
    if (this.reg.source[voxelId(v)] === 1) this.springs.add(pos)
    this.wakeAround(x, y, z)
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

  // ---- step ----

  step(tick: number): void {
    if (this.needsRebuild) this.rebuild()
    if (tick % this.o.fluidEvery !== 0) return
    this.steps++
    // Fluid-step phases (Tasks 5–8 add them here, in this order):
    // flowCells, runOutlets, runContacts, runSprings, queueResurfaces, queueSettles
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

export { AIR, volumeOf }
