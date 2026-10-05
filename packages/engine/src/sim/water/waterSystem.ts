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

/** A displaced volume spreads over columns that each take at most this much (1/16 block). */
const DISPLACE_SHARE = SUB / 16
/** The farthest a displaced volume looks for wet columns, in columns. */
const DISPLACE_RADIUS = 16

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
  /** Whether a full rebuild ran (generation). */
  private built = false
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
  get sea(): number { return this.cycle.sea }
  get stepCount(): number { return this.steps }

  /**
   * Sets the sea level (the generator's configure()) and finds the sea again at once, so the step never pins the old sea's
   * columns to the new level. The sea account follows the sea's water as in a region rebuild (plan decision 7).
   */
  setSeaLevel(v: number): void {
    const cy = this.cycle
    if (v === cy.seaLevel) return
    const before = cy.seaDepth(this.cols)
    cy.seaLevel = v
    if (this.water === 0) return
    cy.findSea(this.cols)
    cy.sea += cy.seaDepth(this.cols) - before
    this.expected = this.total()
  }

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
    // A wall that raised a wet column's floor displaced water: spread it over the lake around at once.
    if (nk === KIND.WALL && col.floor > f0 && d0 > 0) this.displace(x, z, c, f0 * SUB + d0, Math.min(d0, (col.floor - f0) * SUB))
  }

  /**
   * The wall placed at column c displaced `vol` sub-units of water (applyEdit raised the floor and kept the depth). Moves them
   * to the connected wet columns around: a breadth-first search through wet, unblocked neighbours (order -x +x -z +z, radius
   * DISPLACE_RADIUS) picks the first ceil(vol / DISPLACE_SHARE) columns, and each gets an equal integer share; the first
   * `vol mod n` get one more. c itself is one of them while its floor is still under the old surface. With no wet neighbour
   * nothing moves: the water rides on top of the wall. Σ depth is unchanged.
   */
  private displace(x: number, z: number, c: number, s0: number, vol: number): void {
    const cols = this.cols, { floor, depth, sx, sz } = cols, T = cols.tiles
    const want = Math.ceil(vol / DISPLACE_SHARE)
    const self = floor[c]! * SUB < s0
    const found: number[] = [c], dist = [0], seen = new Set<number>([c])
    for (let i = 0; i < found.length && found.length < want + 1; i++) {
      const d = dist[i]!
      if (d >= DISPLACE_RADIUS) continue
      const cc = found[i]!, cx = cc % sx, cz = (cc - cx) / sx
      const from = i === 0 ? s0 : cols.surface(cc)
      for (let k = 0; k < 4; k++) {
        const nx = cx + (k === 0 ? -1 : k === 1 ? 1 : 0), nz = cz + (k === 2 ? -1 : k === 3 ? 1 : 0)
        if (nx < 0 || nz < 0 || nx >= sx || nz >= sz) continue
        const n = nx + nz * sx
        if (seen.has(n) || depth[n]! <= 0 || floor[n]! * SUB >= from) continue
        if (i > 0 && floor[cc]! * SUB >= cols.surface(n)) continue
        seen.add(n)
        found.push(n)
        dist.push(d + 1)
      }
    }
    const targets = (self ? found : found.slice(1)).slice(0, want)
    if (found.length < 2 || targets.length === 0) return
    const n = targets.length, share = Math.floor(vol / n), extra = vol - share * n
    depth[c] = depth[c]! - vol
    for (let i = 0; i < n; i++) {
      const t = targets[i]!, tx = t % sx, tz = (t - tx) / sx
      depth[t] = depth[t]! + share + (i < extra ? 1 : 0)
      T.wake(T.of(tx, tz))
    }
    T.dirty[T.of(x, z)] = 1
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
    const cols = this.cols, T = cols.tiles, sx = cols.sx, floor = cols.floor, depth = cols.depth, mirror = this.mirror
    for (let t = 0; t < T.count; t++) {
      if (T.dirty[t] !== 1) continue
      T.dirty[t] = 0
      out.push(t)
      const x0 = (t % T.tx) * TILE, z0 = Math.floor(t / T.tx) * TILE
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0, c = x0 + z * sx; x < x0 + TILE; x++, c++) {
        mirror.flush(c, x, z, floor[c]!, depth[c]!, this.water, this.kind, this.height, this.get, this.set)
      }
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

  /**
   * Drops all water state and rebuilds every column from the voxels (generation, recovery). After the first (generation,
   * where every chunk is meshed anyway), chunks whose static water became the heightfield's or the other way round are
   * remeshed, as after a regeneration.
   */
  rebuild(): void {
    this.needsRebuild = false
    if (this.water === 0) return
    const [sx, , sz] = this.layout.size, cols = this.cols, cy = this.cycle
    cols.tiles.clear()
    cy.springs.clear()
    const remesh = (ci: number) => this.port.remesh(ci)
    rebuildColumns(this.port.store, this.kind, cols, this.mirror, 0, 0, sx, sz, this.built
      ? (x, z, from, to) => this.waterChunks(x, z, Math.min(from, to), Math.max(from, to), remesh)
      : undefined)
    this.built = true
    this.findSprings(0, 0, sx, sz)
    cy.findSea(cols)
    cy.sea = cy.seaDepth(cols)
    this.wakeUnsettled(0, 0, sx, sz)
    cols.tiles.dirty.fill(1)
    this.expected = this.total()
  }

  /**
   * Rebuilds the columns of chunk columns `ccs` ([cx, cz] pairs) after a regeneration, paused or not (plan decision 10).
   * Only those chunk columns: one between two regenerated ones keeps its columns, flux and films. Returns the chunks whose
   * static water became the heightfield's or the other way round (they need a remesh even if their voxels did not change).
   */
  rebuildChunkColumns(ccs: readonly (readonly [number, number])[]): number[] {
    if (this.water === 0 || ccs.length === 0) return []
    const cols = this.cols, cy = this.cycle, T = cols.tiles, L = this.layout
    const remesh = new Set<number>()
    const regenerated = new Set(ccs.map(([cx, cz]) => cx + cz * L.cx))
    for (const s of [...cy.springs]) {
      const [x, , z] = L.voxelCoords(s)
      if (regenerated.has((x >> 5) + (z >> 5) * L.cx)) cy.springs.delete(s)
    }
    const seaBefore = cy.seaDepth(cols)
    const moved = (x: number, z: number, from: number, to: number) => {
      this.waterChunks(x, z, Math.min(from, to), Math.max(from, to), (ci) => remesh.add(ci))
    }
    for (const [cx, cz] of ccs) {
      rebuildColumns(this.port.store, this.kind, cols, this.mirror, cx * 32, cz * 32, cx * 32 + 32, cz * 32 + 32, moved)
      this.findSprings(cx * 32, cz * 32, cx * 32 + 32, cz * 32 + 32)
    }
    // The sea account follows the sea's water (plan decision 7): a column that joins the sea brings its depth, one that
    // leaves takes the depth it held before the rebuild, and a regenerated sea column adds what its depth changed by.
    cy.findSea(cols)
    cy.sea += cy.seaDepth(cols) - seaBefore
    for (const [cx, cz] of ccs) {
      const x0 = cx * 32, z0 = cz * 32
      for (let tz = z0 / TILE; tz < (z0 + 32) / TILE; tz++) for (let tx = x0 / TILE; tx < (x0 + 32) / TILE; tx++) T.dirty[tx + tz * T.tx] = 1
      this.wakeUnsettled(Math.max(0, x0 - 1), Math.max(0, z0 - 1), Math.min(cols.sx, x0 + 33), Math.min(cols.sz, z0 + 33))
    }
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
