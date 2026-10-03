import type { BlockRegistry } from '../../blocks/registry.ts'
import type { Layout } from '../../world/layout.ts'
import { AIR } from '../../world/voxel.ts'
import type { JobReader, RegionJob } from '../jobs.ts'
import { FULL, flowGroup, volumeOf } from './cell.ts'
import { ChunkBits } from './chunkBits.ts'

/** The fluid system's region-job kinds; a rebuild cancels them. */
export const FLUID_JOBS: ReadonlySet<string> = new Set(['settle', 'split', 'resurface'])

/** A connected body of still liquid found by a scan. Positions are voxel indices. */
export interface ScanComponent {
  liquid: number
  surfaceY: number
  level: number
  surface: number[]
  deep: number[]
  /** Deep cells whose cell above is not in the component: column tops below the surface. */
  capped: number[]
  /** Units held by all its cells. */
  grid: number
  /** Air cells at y ≤ surfaceY next to it (may repeat). */
  outlets: number[]
  /** [own cell, neighbour] for every same-liquid neighbour the scan did not claim. */
  edges: [number, number][]
}

export type Claimable = (x: number, y: number, z: number, pos: number) => boolean

export interface PoolScanOptions {
  kind: string
  registry: BlockRegistry
  layout: Layout
  /** Candidate tops in the order to try them (see sortSeeds). Claimed, unclaimable or non-top seeds are skipped. */
  seeds: readonly number[]
  claimable: Claimable
  onFinish(components: ScanComponent[]): void
}

const DX = [1, -1, 0, 0, 0, 0]
const DY = [0, 0, 1, -1, 0, 0]
const DZ = [0, 0, 0, 0, 1, -1]

/** Highest y first, then by index: a seed's component then claims everything below its surface. */
export function sortSeeds(layout: Layout, seeds: number[]): number[] {
  const layer = layout.size[0] * layout.size[2]
  return seeds.sort((a, b) => Math.floor(b / layer) - Math.floor(a / layer) || a - b)
}

/**
 * Floods bodies of still liquid from seed tops (design notes: Scans). A body's surface is its seed's
 * layer and level; below it, only full cells join. Writes nothing: onFinish installs the result.
 */
export class PoolScan implements RegionJob {
  readonly kind: string
  done = false
  readonly components: ScanComponent[] = []
  private readonly o: PoolScanOptions
  private readonly sx: number
  private readonly layer: number
  private marks: ChunkBits
  private cur: ChunkBits
  private seedAt = 0
  private comp: ScanComponent | null = null
  private queue: number[] = []
  private head = 0

  constructor(o: PoolScanOptions) {
    this.o = o
    this.kind = o.kind
    this.sx = o.layout.size[0]
    this.layer = o.layout.size[0] * o.layout.size[2]
    this.marks = new ChunkBits(o.layout)
    this.cur = new ChunkBits(o.layout)
  }

  step(r: JobReader, budget: number): number {
    let used = 0
    while (used < budget && !this.done) {
      if (this.comp === null) {
        if (this.seedAt >= this.o.seeds.length) { this.done = true; break }
        used++
        this.trySeed(r, this.o.seeds[this.seedAt++]!)
      } else if (this.head < this.queue.length) {
        used++
        this.visit(r, this.queue[this.head++]!)
      } else {
        this.close()
      }
    }
    return used
  }

  finish(): void { this.o.onFinish(this.components) }

  reset(): void {
    this.done = false
    this.components.length = 0
    this.marks = new ChunkBits(this.o.layout)
    this.cur = new ChunkBits(this.o.layout)
    this.seedAt = 0
    this.comp = null
    this.queue = []
    this.head = 0
  }

  mixState(mix: (v: number) => void): void {
    mix(this.seedAt); mix(this.components.length); mix(this.queue.length - this.head); mix(this.done ? 1 : 0)
  }

  private trySeed(r: JobReader, pos: number): void {
    const y = Math.floor(pos / this.layer), rest = pos - y * this.layer, z = Math.floor(rest / this.sx), x = rest - z * this.sx
    if (this.marks.has(x, y, z) || !this.o.claimable(x, y, z, pos)) return
    const reg = this.o.registry
    const v = r.get(x, y, z)
    const g = flowGroup(reg, v)
    if (g === 0 || flowGroup(reg, r.get(x, y + 1, z)) === g) return // not a top
    this.comp = { liquid: g, surfaceY: y, level: volumeOf(reg, v) - 1, surface: [], deep: [], capped: [], grid: 0, outlets: [], edges: [] }
    this.claim(x, y, z, pos)
  }

  private claim(x: number, y: number, z: number, pos: number): void {
    this.marks.add(x, y, z)
    this.cur.add(x, y, z)
    this.queue.push(pos)
  }

  private visit(r: JobReader, pos: number): void {
    const c = this.comp!, reg = this.o.registry, L = this.o.layout
    const y = Math.floor(pos / this.layer), rest = pos - y * this.layer, z = Math.floor(rest / this.sx), x = rest - z * this.sx
    c.grid += volumeOf(reg, r.get(x, y, z))
    if (y === c.surfaceY) c.surface.push(pos)
    else c.deep.push(pos)
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d]!, ny = y + DY[d]!, nz = z + DZ[d]!
      if (ny > c.surfaceY || nx < 0 || ny < 0 || nz < 0 || nx >= L.size[0] || ny >= L.size[1] || nz >= L.size[2]) continue
      if (this.cur.has(nx, ny, nz)) continue
      const npos = L.voxelIndex(nx, ny, nz)
      const nv = r.get(nx, ny, nz)
      if (nv === AIR) { c.outlets.push(npos); continue }
      if (flowGroup(reg, nv) !== c.liquid) continue
      if (this.marks.has(nx, ny, nz) || !this.o.claimable(nx, ny, nz, npos)) { c.edges.push([pos, npos]); continue }
      const units = volumeOf(reg, nv)
      const fits = ny === c.surfaceY
        ? units - 1 === c.level && flowGroup(reg, r.get(nx, ny + 1, nz)) !== c.liquid
        : units === FULL && this.ownsColumn(r, nx, ny, nz)
      if (fits) this.claim(nx, ny, nz, npos)
      else c.edges.push([pos, npos])
    }
  }

  /**
   * A deep cell belongs to this body only if its water column ends at this body's surface (same level)
   * or under a ceiling. A column that ends lower with air above is a separate body with its own,
   * lower surface: the two become pools in contact, so connected water at different heights is never
   * forced flat at the higher one.
   */
  private ownsColumn(r: JobReader, x: number, y: number, z: number): boolean {
    const c = this.comp!, reg = this.o.registry
    for (let yy = y + 1; yy <= c.surfaceY + 1; yy++) {
      if (this.cur.has(x, yy, z)) return true
      const v = r.get(x, yy, z)
      if (flowGroup(reg, v) === c.liquid) {
        if (yy > c.surfaceY) return false
        continue
      }
      const top = yy - 1
      if (top === c.surfaceY) return volumeOf(reg, r.get(x, top, z)) - 1 === c.level
      return v !== AIR // a ceiling keeps the cave in the body; air means a lower, open surface
    }
    return false
  }

  private close(): void {
    const c = this.comp!
    for (const pos of c.deep) {
      const y = Math.floor(pos / this.layer), rest = pos - y * this.layer, z = Math.floor(rest / this.sx), x = rest - z * this.sx
      if (!this.cur.has(x, y + 1, z)) c.capped.push(pos)
    }
    this.cur = new ChunkBits(this.o.layout)
    this.components.push(c)
    this.comp = null
    this.queue = []
    this.head = 0
  }
}
