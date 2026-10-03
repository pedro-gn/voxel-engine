import { Layout } from '../../world/layout.ts'

/** One bit per voxel, allocated 4 KB per chunk on the first set. Out-of-world coordinates read false and ignore writes. */
export class ChunkBits {
  private readonly layout: Layout
  private readonly chunks = new Map<number, Uint32Array>()
  private readonly sx: number
  private readonly sy: number
  private readonly sz: number
  constructor(layout: Layout) {
    this.layout = layout
    ;[this.sx, this.sy, this.sz] = layout.size
  }

  private words(x: number, y: number, z: number, create: boolean): Uint32Array | undefined {
    if (x < 0 || y < 0 || z < 0 || x >= this.sx || y >= this.sy || z >= this.sz) return undefined
    const ci = this.layout.chunkOf(x, y, z)
    let w = this.chunks.get(ci)
    if (!w && create) { w = new Uint32Array(1024); this.chunks.set(ci, w) }
    return w
  }

  has(x: number, y: number, z: number): boolean {
    const w = this.words(x, y, z, false)
    if (!w) return false
    const i = Layout.localIndex(x & 31, y & 31, z & 31)
    return ((w[i >>> 5]! >>> (i & 31)) & 1) === 1
  }

  add(x: number, y: number, z: number): void {
    const w = this.words(x, y, z, true)
    if (!w) return
    const i = Layout.localIndex(x & 31, y & 31, z & 31)
    w[i >>> 5] = w[i >>> 5]! | (1 << (i & 31))
  }

  delete(x: number, y: number, z: number): void {
    const w = this.words(x, y, z, false)
    if (!w) return
    const i = Layout.localIndex(x & 31, y & 31, z & 31)
    w[i >>> 5] = w[i >>> 5]! & ~(1 << (i & 31))
  }

  clear(): void { this.chunks.clear() }

  /** Set bits; for tests and invariant checks. */
  count(): number {
    let n = 0
    for (const w of this.chunks.values()) for (let i = 0; i < w.length; i++) {
      let v = w[i]!
      while (v !== 0) { v &= v - 1; n++ }
    }
    return n
  }
}
