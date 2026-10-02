import { SlotViews, decodeUniform, impliedLight, type WorldBuffers } from './buffers.ts'
import { Layout } from './layout.ts'
import { AIR, FULL_SKY, voxelId } from './voxel.ts'

export const PAD = 34
export const PAD_VOLUME = PAD * PAD * PAD
export function padIndex(px: number, py: number, pz: number): number { return px + pz * PAD + py * PAD * PAD }

export interface ChunkSnapshot { voxels: Uint16Array; light: Uint8Array }
export function createSnapshot(): ChunkSnapshot {
  return { voxels: new Uint16Array(PAD_VOLUME), light: new Uint8Array(PAD_VOLUME) }
}

const FACE_NEIGHBOURS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
]

/** Read-only view of world memory. Used by the main thread and mesh workers. */
export class WorldReader {
  readonly layout: Layout
  readonly table: Int32Array
  readonly versions: Uint32Array
  private readonly views = new SlotViews()
  private readonly opaque: Uint8Array
  /** Reader-private word; only ever touched by `fence()`. */
  private readonly fenceWord = new Int32Array(new SharedArrayBuffer(4))

  constructor(buffers: WorldBuffers, opaque: Uint8Array) {
    this.layout = new Layout(buffers.size)
    this.table = new Int32Array(buffers.chunkTable)
    this.versions = new Uint32Array(buffers.versions)
    this.opaque = opaque
  }

  addPage(index: number, page: SharedArrayBuffer): void { this.views.addPage(index, page) }

  /**
   * Orders every earlier load before every later one. Call it between a seqlock's plain data
   * reads and the `Atomics.load` of the version that validates them. On ARM64 that load is
   * acquire-only, so earlier plain loads could still complete after it and a torn read would
   * pass validation. The JS memory model has no standalone fence; a no-op seq-cst RMW is the
   * closest thing (acq_rel on ARM64, a locked instruction on x86, so free of semantic change there).
   */
  fence(): void { Atomics.add(this.fenceWord, 0, 0) }

  get(x: number, y: number, z: number): number {
    if (!this.layout.inBounds(x, y, z)) return AIR
    const e = this.table[this.layout.chunkOf(x, y, z)]!
    if (e < 0) return decodeUniform(e)
    if (!this.views.hasSlot(e)) return AIR
    return this.views.voxels(e)[Layout.localIndex(x & 31, y & 31, z & 31)]!
  }

  getLight(x: number, y: number, z: number): number {
    if (!this.layout.inBounds(x, y, z)) return FULL_SKY
    const e = this.table[this.layout.chunkOf(x, y, z)]!
    if (e < 0) return impliedLight(decodeUniform(e), this.opaque)
    if (!this.views.hasSlot(e)) return FULL_SKY
    return this.views.light(e)[Layout.localIndex(x & 31, y & 31, z & 31)]!
  }

  snapshot(ci: number, out: ChunkSnapshot, retries = 8): number | null {
    const L = this.layout
    const [cx, cy, cz] = L.chunkCoords(ci)
    const involved: number[] = []
    let centre = 0
    for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0 && dz === 0) centre = involved.length
      if (L.chunkInBounds(cx + dx, cy + dy, cz + dz)) involved.push(L.chunkIndex(cx + dx, cy + dy, cz + dz))
    }
    const before = new Array<number>(involved.length)
    for (let attempt = 0; attempt < retries; attempt++) {
      let busy = false
      for (let i = 0; i < involved.length; i++) {
        before[i] = Atomics.load(this.versions, involved[i]!)
        if (before[i]! & 1) busy = true
      }
      if (busy) continue
      if (!this.copy(cx, cy, cz, out)) return null
      this.fence()
      let stable = true
      for (let i = 0; i < involved.length; i++) {
        if (Atomics.load(this.versions, involved[i]!) !== before[i]) { stable = false; break }
      }
      if (stable) return before[centre]!  // the validated version, not a fresh load
    }
    return null
  }

  isTrivial(ci: number): boolean {
    const e = this.table[ci]!
    if (e >= 0) return false
    const id = voxelId(decodeUniform(e))
    if (id === 0) return true
    if (!this.opaque[id]) return false
    const [cx, cy, cz] = this.layout.chunkCoords(ci)
    for (const [dx, dy, dz] of FACE_NEIGHBOURS) {
      if (!this.layout.chunkInBounds(cx + dx, cy + dy, cz + dz)) return false
      const n = this.table[this.layout.chunkIndex(cx + dx, cy + dy, cz + dz)]!
      if (n >= 0 || !this.opaque[voxelId(decodeUniform(n))]) return false
    }
    return true
  }

  private copy(cx: number, cy: number, cz: number, out: ChunkSnapshot): boolean {
    const [SX, SY, SZ] = this.layout.size
    const bx = cx * 32, by = cy * 32, bz = cz * 32
    for (let py = 0; py < PAD; py++) {
      const y = by + py - 1
      for (let pz = 0; pz < PAD; pz++) {
        const z = bz + pz - 1
        const row = padIndex(0, py, pz)
        if (y < 0 || y >= SY || z < 0 || z >= SZ) {
          out.voxels.fill(AIR, row, row + PAD)
          out.light.fill(FULL_SKY, row, row + PAD)
          continue
        }
        if (!this.copySegment(bx - 1, 1, y, z, out, row, SX)) return false
        if (!this.copySegment(bx, 32, y, z, out, row + 1, SX)) return false
        if (!this.copySegment(bx + 32, 1, y, z, out, row + 33, SX)) return false
      }
    }
    return true
  }

  /** Copies `count` voxels starting at world x (all within one chunk) into out at `dst`. */
  private copySegment(x: number, count: number, y: number, z: number, out: ChunkSnapshot, dst: number, SX: number): boolean {
    if (x < 0 || x >= SX) {
      out.voxels.fill(AIR, dst, dst + count)
      out.light.fill(FULL_SKY, dst, dst + count)
      return true
    }
    const e = this.table[this.layout.chunkOf(x, y, z)]!
    if (e < 0) {
      const v = decodeUniform(e)
      out.voxels.fill(v, dst, dst + count)
      out.light.fill(impliedLight(v, this.opaque), dst, dst + count)
      return true
    }
    if (!this.views.hasSlot(e)) return false
    const local = Layout.localIndex(x & 31, y & 31, z & 31)
    out.voxels.set(this.views.voxels(e).subarray(local, local + count), dst)
    out.light.set(this.views.light(e).subarray(local, local + count), dst)
    return true
  }
}
