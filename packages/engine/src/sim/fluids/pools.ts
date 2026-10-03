import type { Layout } from '../../world/layout.ts'
import type { ChunkBits } from './chunkBits.ts'
import type { SurfaceIndex } from './surfaceIndex.ts'

/** A settled body of liquid with a flat surface (design notes: Members and ownership). */
export interface Pool {
  readonly id: number
  /** The liquid group: the base liquid's block id. */
  readonly liquid: number
  surfaceY: number
  /** The level (0–7) of every surface cell. */
  level: number
  /** Surface cells. */
  area: number
  /** Units the pool's cells hold in the grid. */
  grid: number
  /** Units not shown in the grid yet. The true volume is grid + balance. */
  balance: number
  /** The sea that springs draw from. */
  cycle: boolean
  /** It could not add a layer: everything above its surface is solid. */
  sealed: boolean
  /** A region job is rewriting or rescanning it: it neither joins cells nor moves water. */
  frozen: boolean
  /** Surface-index tile keys holding its surface cells. */
  readonly tiles: Set<number>
  /** Voxel indices of its capped column tops. */
  readonly capped: Set<number>
  /** Voxel indices it fills each fluid step. */
  readonly outlets: Set<number>
}

export class PoolTable {
  /** Member column tops below their pool's surface: voxel index → pool id (raw; resolve it). */
  readonly capped = new Map<number, number>()
  private readonly layout: Layout
  private readonly index: SurfaceIndex
  private readonly members: ChunkBits
  private readonly live = new Map<number, Pool>()
  private readonly alias = new Map<number, number>()
  private nextId = 1

  constructor(layout: Layout, index: SurfaceIndex, members: ChunkBits) {
    this.layout = layout
    this.index = index
    this.members = members
  }

  get count(): number { return this.live.size }

  create(liquid: number, surfaceY: number, level: number): Pool {
    const p: Pool = {
      id: this.nextId++, liquid, surfaceY, level, area: 0, grid: 0, balance: 0,
      cycle: false, sealed: false, frozen: false, tiles: new Set(), capped: new Set(), outlets: new Set(),
    }
    this.live.set(p.id, p)
    return p
  }

  /** Follows merges to the live pool's id; 0 when the pool no longer exists. */
  resolve(id: number): number {
    let cur = id
    while (!this.live.has(cur)) {
      const next = this.alias.get(cur)
      if (next === undefined) return 0
      cur = next
    }
    if (cur !== id) this.alias.set(id, cur)
    return cur
  }

  get(id: number): Pool | undefined {
    const r = this.resolve(id)
    return r === 0 ? undefined : this.live.get(r)
  }

  /** Live pools in id order (ids only grow, and a Map keeps insertion order). */
  all(): Pool[] { return [...this.live.values()] }

  /** Forgets a pool. Its index entries, capped entries and member bits are the caller's to clean. */
  remove(p: Pool): void { this.live.delete(p.id) }

  /** Folds `from` into `into` (same surfaceY). Levels may differ; the caller normalises them with a resurface job. */
  merge(into: Pool, from: Pool): void {
    if (into === from) return
    this.live.delete(from.id)
    this.alias.set(from.id, into.id)
    into.area += from.area
    into.grid += from.grid
    into.balance += from.balance
    into.cycle = into.cycle || from.cycle
    into.sealed = false
    for (const t of from.tiles) into.tiles.add(t)
    for (const c of from.capped) into.capped.add(c)
    for (const o of from.outlets) into.outlets.add(o)
  }

  /** The pool owning a member cell: walks up member cells to a surface entry or a capped top. */
  ownerOf(x: number, y: number, z: number): Pool | undefined {
    if (!this.members.has(x, y, z)) return undefined
    const H = this.layout.size[1]
    for (let yy = y; ; yy++) {
      const s = this.index.get(x, yy, z)
      if (s !== 0) {
        const p = this.get(s)
        if (p && p.surfaceY === yy) return p
      }
      const c = this.capped.get(this.layout.voxelIndex(x, yy, z))
      if (c !== undefined) {
        const p = this.get(c)
        if (p) return p
      }
      if (yy + 1 >= H || !this.members.has(x, yy + 1, z)) return undefined
    }
  }

  clear(): void {
    this.live.clear()
    this.alias.clear()
    this.capped.clear()
    this.nextId = 1
  }

  mixState(mix: (v: number) => void): void {
    mix(this.nextId)
    mix(this.alias.size)
    mix(this.capped.size)
    for (const p of this.live.values()) {
      mix(p.id); mix(p.liquid); mix(p.surfaceY); mix(p.level); mix(p.area); mix(p.grid); mix(p.balance)
      mix((p.cycle ? 1 : 0) | (p.sealed ? 2 : 0) | (p.frozen ? 4 : 0))
      mix(p.tiles.size); mix(p.capped.size); mix(p.outlets.size)
    }
  }
}
