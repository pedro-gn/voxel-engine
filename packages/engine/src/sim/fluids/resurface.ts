import type { Layout } from '../../world/layout.ts'
import type { JobReader, RegionJob } from '../jobs.ts'
import type { PoolTable } from './pools.ts'
import type { SurfaceIndex } from './surfaceIndex.ts'

export interface ResurfaceOptions {
  poolId: number
  pools: PoolTable
  index: SurfaceIndex
  layout: Layout
  /** Rewrites the pool from its collected surface cells (FluidSystem.applyResurface). */
  apply(poolId: number, cells: number[]): void
}

/**
 * Collects a pool's surface cells from its index tiles (1024 entries count as 1024 cells of budget);
 * finish() hands them over to be rewritten at once, so the whole surface changes in one tick. It reads
 * the index, not the world, so it never goes stale: the apply step validates every cell instead.
 */
export class Resurface implements RegionJob {
  readonly kind = 'resurface'
  done = false
  private tiles: number[] | null = null
  private at = 0
  private readonly cells: number[] = []

  private readonly o: ResurfaceOptions

  constructor(o: ResurfaceOptions) { this.o = o }

  step(_r: JobReader, budget: number): number {
    const p = this.o.pools.get(this.o.poolId)
    if (!p) { this.done = true; return 1 }
    if (this.tiles === null) this.tiles = [...p.tiles]
    let used = 0
    while (used < budget && this.at < this.tiles.length) {
      const key = this.tiles[this.at++]!
      used += 1024
      const t = this.o.index.tile(key)
      if (!t) continue
      const [x0, y, z0] = this.o.index.origin(key)
      for (let i = 0; i < 1024; i++) {
        if (t[i] !== 0 && this.o.pools.resolve(t[i]!) === p.id) this.cells.push(this.o.layout.voxelIndex(x0 + (i & 31), y, z0 + (i >> 5)))
      }
    }
    if (this.at >= this.tiles.length) this.done = true
    return Math.max(used, 1)
  }

  finish(): void { this.o.apply(this.o.poolId, this.cells) }

  reset(): void {
    this.done = false
    this.tiles = null
    this.at = 0
    this.cells.length = 0
  }

  mixState(mix: (v: number) => void): void { mix(this.o.poolId); mix(this.at); mix(this.cells.length) }
}
