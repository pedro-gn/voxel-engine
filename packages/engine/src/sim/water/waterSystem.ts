import { waterGroupOf, type BlockRegistry } from '../../blocks/registry.ts'
import type { ChunkStore } from '../../world/chunkStore.ts'
import type { Layout } from '../../world/layout.ts'
import { AIR, voxelId, voxelState } from '../../world/voxel.ts'
import type { WaterBuffers } from '../../world/waterBuffers.ts'
import { WaterColumns } from './columns.ts'
import { KIND, MIN_FLOW, SUB, TILE } from './constants.ts'
import { WaterCycle } from './cycle.ts'
import { applyEdit, type ColumnCells, type EditColumn } from './edits.ts'
import { WaterMirror } from './mirror.ts'
import { WaterPublisher, type WaterTick } from './publish.ts'
import { rebuildColumns, waterKinds } from './rebuild.ts'

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
  /** Chunk ci must be remeshed at the next commit: static water in it became the heightfield's. */
  remesh(ci: number): void
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
  private readonly edit: EditColumn = { floor: 0, depth: 0 }
  private ex = 0
  private ez = 0
  private readonly cells: ColumnCells
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
    this.cycle = new WaterCycle(sx * sz)
    this.mirror = new WaterMirror(sx * sz)
    this.publisher = new WaterPublisher(port.buffers)
    this.get = (x, y, z) => port.get(x, y, z)
    this.set = (x, y, z, v) => port.setQuiet(x, y, z, v)
    const sys = this
    this.cells = {
      height: this.height,
      kind: (y) => sys.kind[voxelId(port.get(sys.ex, y, sys.ez))]!,
      units: (y) => {
        const v = port.get(sys.ex, y, sys.ez)
        return sys.kind[voxelId(v)] === KIND.WATER ? (voxelState(v) & 7) + 1 : 0
      },
    }
  }

  get enabled(): boolean { return this.water !== 0 }
  get seaLevel(): number { return this.cycle.seaLevel }
  set seaLevel(v: number) { this.cycle.seaLevel = v }
  get sea(): number { return this.cycle.sea }
  get stepCount(): number { return this.steps }

  /** Σ depth + sea. */
  total(): number { return this.cols.total() + this.cycle.sea }

  /** Awake tiles and the wet columns in them. */
  stats(): { tiles: number; columns: number } {
    return { tiles: this.cols.tiles.awakeCount(), columns: this.cols.wetAwake() }
  }

  /** Column (x, z): floor, depth and surface. For tests and tools. */
  column(x: number, z: number): { floor: number; depth: number; surface: number } {
    const c = x + z * this.cols.sx
    return { floor: this.cols.floor[c]!, depth: this.cols.depth[c]!, surface: this.cols.surface(c) }
  }

  /** Every voxel write except the mirror's comes here, after the store took it (Simulation.applySet), paused or not. */
  onWrite(x: number, y: number, z: number, old: number, v: number): void {
    if (this.water === 0) return
    const reg = this.port.registry
    if (reg.source[voxelId(old)] === 1) this.cycle.springs.delete(this.layout.voxelIndex(x, y, z))
    if (reg.source[voxelId(v)] === 1) this.cycle.springs.add(this.layout.voxelIndex(x, y, z))
    const ok = this.kind[voxelId(old)]!, nk = this.kind[voxelId(v)]!
    if (ok === nk && nk !== KIND.WATER) return // wall for wall: nothing for water
    const cols = this.cols, c = x + z * cols.sx
    const f0 = cols.floor[c]!, d0 = cols.depth[c]!
    const col = this.edit
    col.floor = f0
    col.depth = d0
    this.ex = x
    this.ez = z
    applyEdit(col, y, ok, nk, nk === KIND.WATER ? (voxelState(v) & 7) + 1 : 0, this.cells)
    const T = cols.tiles
    if (col.floor === f0 && col.depth === d0) {
      // No column change, but a cell in or above the water did change (a removed block in the water, a stray voxel): re-mirror.
      if (y >= f0) { this.mirror.touch(c, y); T.dirty[T.of(x, z)] = 1 }
      return
    }
    // A wall in the water pushed the water under it up: those cells are now under the floor and hold nothing. Clear them
    // before any later write this tick reads them (a dug-out floor would count them again).
    if (nk === KIND.WALL) for (let yy = f0; yy < col.floor - 1; yy++) {
      if (this.kind[voxelId(this.port.get(x, yy, z))] === KIND.WATER) this.set(x, yy, z, AIR)
    }
    cols.floor[c] = col.floor
    cols.depth[c] = col.depth
    this.expected += col.depth - d0
    this.mirror.touch(c, y)
    T.dirty[T.of(x, z)] = 1
    if (this.wetAround(x, z)) T.wakeAround(x, z)
    if (col.floor !== f0) this.floorMoved(x, z, c, f0, col.floor)
  }

  /** One physics step (spec §3): springs, flow over the awake tiles, the sea. Not called while paused. */
  step(): void {
    if (this.water === 0) return
    if (this.needsRebuild) this.rebuild()
    this.steps++
    const cy = this.cycle
    cy.runSprings(this.cols, this.layout, this.get, this.port.registry.source)
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
    // A pending rebuild means the columns are suspect: keep the voxels as the truth and the tiles dirty.
    if (this.water === 0 || this.needsRebuild) return out
    const cols = this.cols, T = cols.tiles
    for (let t = 0; t < T.count; t++) {
      if (T.dirty[t] !== 1) continue
      T.dirty[t] = 0
      out.push(t)
      T.forEachColumn(t, (c, x, z) => {
        this.mirror.flush(c, x, z, cols.floor[c]!, cols.depth[c]!, this.water, this.kind, this.height, this.get, this.set)
      })
    }
    this.published = this.publisher.publish(out, cols)
    return out
  }

  /** The conservation identity and non-negative depths (spec §8). Whole world: for debug builds and tests. */
  check(): string[] {
    const out: string[] = []
    const d = this.cols.depth
    for (let c = 0; c < this.cols.n && out.length < 3; c++) if (d[c]! < 0) out.push(`column ${c} has depth ${d[c]}`)
    const t = this.total()
    if (t !== this.expected) out.push(`Σ depth + sea is ${t}, expected ${this.expected}`)
    return out
  }

  /** Drops all water state and rebuilds every column from the voxels (generation, recovery). */
  rebuild(): void {
    this.needsRebuild = false
    if (this.water === 0) return
    const [sx, , sz] = this.layout.size, cols = this.cols, cy = this.cycle
    cols.tiles.clear()
    cy.springs.clear()
    rebuildColumns(this.port.store, this.kind, cols, this.mirror, 0, 0, sx, sz)
    this.findSprings(0, 0, sx, sz)
    cy.findSea(cols)
    cy.sea = cy.seaDepth(cols)
    this.wakeUnsettled(0, 0, sx, sz)
    cols.tiles.dirty.fill(1)
    this.expected = this.total()
  }

  /**
   * Rebuilds columns [x0, x1) × [z0, z1) after a regeneration, paused or not (plan decision 10). Returns the chunks whose
   * static water became the heightfield's or the other way round (they need a remesh even if their voxels did not change).
   */
  rebuildRegion(x0: number, z0: number, x1: number, z1: number): number[] {
    if (this.water === 0) return []
    const cols = this.cols, cy = this.cycle, T = cols.tiles
    const remesh = new Set<number>()
    for (const s of [...cy.springs]) {
      const [x, , z] = this.layout.voxelCoords(s)
      if (x >= x0 && x < x1 && z >= z0 && z < z1) cy.springs.delete(s)
    }
    const seaBefore = cy.seaDepth(cols)
    rebuildColumns(this.port.store, this.kind, cols, this.mirror, x0, z0, x1, z1, (x, z, from, to) => {
      this.waterChunks(x, z, Math.min(from, to), Math.max(from, to), (ci) => remesh.add(ci))
    })
    this.findSprings(x0, z0, x1, z1)
    // The sea account follows the sea's water (plan decision 7): a column that joins the sea brings its depth, one that
    // leaves takes the depth it held before the rebuild, and a regenerated sea column adds what its depth changed by.
    cy.findSea(cols)
    cy.sea += cy.seaDepth(cols) - seaBefore
    for (let tz = Math.floor(z0 / TILE); tz <= Math.floor((z1 - 1) / TILE); tz++) {
      for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x1 - 1) / TILE); tx++) T.dirty[tx + tz * T.tx] = 1
    }
    this.wakeUnsettled(Math.max(0, x0 - 1), Math.max(0, z0 - 1), Math.min(cols.sx, x1 + 1), Math.min(cols.sz, z1 + 1))
    this.expected = this.total()
    return [...remesh].sort((a, b) => a - b)
  }

  mixState(mix: (v: number) => void): void {
    mix(this.steps)
    mix(this.needsRebuild ? 1 : 0)
    this.cols.mixState(mix)
    this.cycle.mixState(mix)
    this.mirror.mixState(mix)
  }

  /** Whether column (x, z) or one of its four neighbours holds water: only then can an edit there move any. */
  private wetAround(x: number, z: number): boolean {
    const { depth, sx, sz } = this.cols, c = x + z * sx
    return depth[c]! > 0 || (x > 0 && depth[c - 1]! > 0) || (x + 1 < sx && depth[c + 1]! > 0) ||
      (z > 0 && depth[c - sx]! > 0) || (z + 1 < sz && depth[c + sx]! > 0)
  }

  private floorMoved(x: number, z: number, c: number, from: number, to: number): void {
    if (to >= this.cycle.seaLevel) this.cycle.mask[c] = 0
    this.springAt(x, to - 1, z)
    // Static water the floor uncovered was the voxel mesher's: remesh its chunks now that the heightfield draws it.
    if (to < from) this.waterChunks(x, z, to, from, (ci) => this.port.remesh(ci))
  }

  /** Calls `out` once per chunk of column (x, z) that holds water in [y0, y1). */
  private waterChunks(x: number, z: number, y0: number, y1: number, out: (ci: number) => void): void {
    let last = -1
    for (let y = Math.max(0, y0); y < Math.min(this.height, y1); y++) {
      if (this.kind[voxelId(this.port.get(x, y, z))] !== KIND.WATER) continue
      const cy = y >> 5
      if (cy !== last) { out(this.layout.chunkIndex(x >> 5, cy, z >> 5)); last = cy }
    }
  }

  /** Remembers a spring at (x, y, z) if there is one (a column's floor block). */
  private springAt(x: number, y: number, z: number): void {
    if (y < 0 || y >= this.height) return
    if (this.port.registry.source[voxelId(this.port.get(x, y, z))] === 1) this.cycle.springs.add(this.layout.voxelIndex(x, y, z))
  }

  private findSprings(x0: number, z0: number, x1: number, z1: number): void {
    const { floor, sx } = this.cols
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) this.springAt(x, floor[x + z * sx]! - 1, z)
  }

  /** Wakes the tile of every wet, non-sea column in the range that stands above a neighbour it can flow to. */
  private wakeUnsettled(x0: number, z0: number, x1: number, z1: number): void {
    const { floor, depth, sx, sz, tiles } = this.cols, mask = this.cycle.mask
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      const c = x + z * sx, d = depth[c]!
      if (d < MIN_FLOW || mask[c] === 1) continue
      const s = floor[c]! * SUB + d
      if ((x > 0 && s > this.cols.surface(c - 1)) || (x + 1 < sx && s > this.cols.surface(c + 1)) ||
        (z > 0 && s > this.cols.surface(c - sx)) || (z + 1 < sz && s > this.cols.surface(c + sx))) tiles.wake(tiles.of(x, z))
    }
  }
}
