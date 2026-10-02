import { PAGE_BYTES, SLOTS_PER_PAGE, SlotViews, decodeUniform, encodeUniform, impliedLight, type WorldBuffers } from './buffers.ts'
import { CHUNK_VOLUME, Layout } from './layout.ts'
import { AIR, FULL_SKY, voxelId } from './voxel.ts'

export class WorldFullError extends Error {
  /** `slots`: slot count in use when allocation failed. */
  readonly slots: number
  constructor(message: string, slots = 0) { super(message); this.name = 'WorldFullError'; this.slots = slots }
}

export interface ChunkStoreOptions {
  buffers: WorldBuffers
  opaque: Uint8Array
  onNewPage?: (index: number, page: SharedArrayBuffer) => void
  maxPages?: number
}

/** The only writer of world memory. Lives in the sim worker (and in tests). */
export class ChunkStore {
  readonly layout: Layout
  readonly table: Int32Array
  readonly versions: Uint32Array
  readonly views = new SlotViews()
  private readonly opaque: Uint8Array
  private readonly onNewPage?: (index: number, page: SharedArrayBuffer) => void
  private readonly maxPages: number
  private readonly free: number[] = []
  private nextSlot = 0
  private readonly open = new Set<number>()
  private readonly dirty = new Set<number>()

  constructor(o: ChunkStoreOptions) {
    this.layout = new Layout(o.buffers.size)
    this.table = new Int32Array(o.buffers.chunkTable)
    this.versions = new Uint32Array(o.buffers.versions)
    this.opaque = o.opaque
    this.onNewPage = o.onNewPage
    this.maxPages = o.maxPages ?? 64
  }

  getVoxel(x: number, y: number, z: number): number {
    if (!this.layout.inBounds(x, y, z)) return AIR
    const e = this.table[this.layout.chunkOf(x, y, z)]!
    if (e < 0) return decodeUniform(e)
    return this.views.voxels(e)[Layout.localIndex(x & 31, y & 31, z & 31)]!
  }

  getLight(x: number, y: number, z: number): number {
    if (!this.layout.inBounds(x, y, z)) return FULL_SKY
    const e = this.table[this.layout.chunkOf(x, y, z)]!
    if (e < 0) return impliedLight(decodeUniform(e), this.opaque)
    return this.views.light(e)[Layout.localIndex(x & 31, y & 31, z & 31)]!
  }

  setVoxel(x: number, y: number, z: number, v: number): boolean {
    if (!this.layout.inBounds(x, y, z)) return false
    if (this.getVoxel(x, y, z) === v) return false
    const slot = this.writable(this.layout.chunkOf(x, y, z))
    this.views.voxels(slot)[Layout.localIndex(x & 31, y & 31, z & 31)] = v
    this.markBorder(x, y, z)
    return true
  }

  setLight(x: number, y: number, z: number, l: number): void {
    if (!this.layout.inBounds(x, y, z)) return
    if (this.getLight(x, y, z) === l) return
    const slot = this.writable(this.layout.chunkOf(x, y, z))
    this.views.light(slot)[Layout.localIndex(x & 31, y & 31, z & 31)] = l
    this.markBorder(x, y, z)
  }

  writeChunkDense(ci: number, voxels: Uint16Array): void {
    const v0 = voxels[0]!
    let uniform = true
    for (let i = 1; i < CHUNK_VOLUME; i++) if (voxels[i] !== v0) { uniform = false; break }
    if (uniform) {
      const e = this.table[ci]!
      if (e < 0 && decodeUniform(e) === v0) return
      this.openChunk(ci)
      if (e >= 0) this.free.push(e)
      Atomics.store(this.table, ci, encodeUniform(v0))
      return
    }
    const slot = this.writable(ci)
    this.views.voxels(slot).set(voxels)
    const light = this.views.light(slot)
    for (let i = 0; i < CHUNK_VOLUME; i++) light[i] = this.opaque[voxelId(voxels[i]!)] ? 0 : FULL_SKY
  }

  slotOf(ci: number): number {
    const e = this.table[ci]!
    return e >= 0 ? e : -1
  }

  slotsUsed(): number { return this.nextSlot - this.free.length }

  commit(): number[] {
    const out = new Set(this.dirty)
    for (const ci of this.open) {
      this.tryCollapse(ci)
      Atomics.add(this.versions, ci, 1) // back to even: stable
      out.add(ci)
    }
    this.open.clear()
    this.dirty.clear()
    return [...out].sort((a, b) => a - b)
  }

  private openChunk(ci: number): void {
    if (this.open.has(ci)) return
    Atomics.add(this.versions, ci, 1) // odd: write in progress
    this.open.add(ci)
  }

  private writable(ci: number): number {
    this.openChunk(ci)
    const e = this.table[ci]!
    if (e >= 0) return e
    const v = decodeUniform(e)
    const slot = this.allocSlot()
    this.views.voxels(slot).fill(v)
    this.views.light(slot).fill(impliedLight(v, this.opaque))
    Atomics.store(this.table, ci, slot)
    return slot
  }

  private allocSlot(): number {
    const reused = this.free.pop()
    if (reused !== undefined) return reused
    if (this.nextSlot >= this.views.pageCount * SLOTS_PER_PAGE) this.addPage()
    return this.nextSlot++
  }

  private addPage(): void {
    const index = this.views.pageCount
    if (index >= this.maxPages) throw new WorldFullError(`world full: ${index} pages (${index * SLOTS_PER_PAGE} slots) in use`, index * SLOTS_PER_PAGE)
    let page: SharedArrayBuffer
    try {
      page = new SharedArrayBuffer(PAGE_BYTES)
    } catch (err) {
      throw new WorldFullError(`could not allocate slot page ${index}: ${String(err)}`, index * SLOTS_PER_PAGE)
    }
    this.views.addPage(index, page)
    this.onNewPage?.(index, page)
  }

  private tryCollapse(ci: number): void {
    const e = this.table[ci]!
    if (e < 0) return
    const vox = this.views.voxels(e)
    const v0 = vox[0]!
    for (let i = 1; i < CHUNK_VOLUME; i++) if (vox[i] !== v0) return
    const l0 = impliedLight(v0, this.opaque)
    const light = this.views.light(e)
    for (let i = 0; i < CHUNK_VOLUME; i++) if (light[i] !== l0) return
    Atomics.store(this.table, ci, encodeUniform(v0))
    this.free.push(e)
  }

  /** A change on a chunk face/edge/corner affects neighbour meshes (face culling, AO, light). */
  private markBorder(x: number, y: number, z: number): void {
    const lx = x & 31, ly = y & 31, lz = z & 31
    const xs = lx === 0 ? [-1, 0] : lx === 31 ? [0, 1] : [0]
    const ys = ly === 0 ? [-1, 0] : ly === 31 ? [0, 1] : [0]
    const zs = lz === 0 ? [-1, 0] : lz === 31 ? [0, 1] : [0]
    if (xs.length + ys.length + zs.length === 3) return
    const cx = x >> 5, cy = y >> 5, cz = z >> 5
    for (const dy of ys) for (const dz of zs) for (const dx of xs) {
      if (dx === 0 && dy === 0 && dz === 0) continue
      if (this.layout.chunkInBounds(cx + dx, cy + dy, cz + dz)) this.dirty.add(this.layout.chunkIndex(cx + dx, cy + dy, cz + dz))
    }
  }
}
