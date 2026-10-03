import type { Layout } from '../../world/layout.ts'

/** Pool ids of surface cells, in sparse 32 × 32 tiles per (chunk column, y). 0 = no pool. */
export class SurfaceIndex {
  private readonly layout: Layout
  private readonly tiles = new Map<number, Int32Array>()
  constructor(layout: Layout) { this.layout = layout }

  key(x: number, y: number, z: number): number {
    return (y * this.layout.cz + (z >> 5)) * this.layout.cx + (x >> 5)
  }

  /** The world position of a tile's first cell: [x0, y, z0]. */
  origin(key: number): [number, number, number] {
    const { cx, cz } = this.layout
    const tx = key % cx
    const rest = (key - tx) / cx
    const tz = rest % cz
    return [tx * 32, (rest - tz) / cz, tz * 32]
  }

  private inside(x: number, y: number, z: number): boolean {
    const [sx, sy, sz] = this.layout.size
    return x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz
  }

  get(x: number, y: number, z: number): number {
    if (!this.inside(x, y, z)) return 0
    const t = this.tiles.get(this.key(x, y, z))
    return t ? t[(x & 31) | ((z & 31) << 5)]! : 0
  }

  /** Records a surface cell and returns its tile key. */
  set(x: number, y: number, z: number, id: number): number {
    const k = this.key(x, y, z)
    let t = this.tiles.get(k)
    if (!t) { t = new Int32Array(1024); this.tiles.set(k, t) }
    t[(x & 31) | ((z & 31) << 5)] = id
    return k
  }

  delete(x: number, y: number, z: number): void {
    if (!this.inside(x, y, z)) return
    const t = this.tiles.get(this.key(x, y, z))
    if (t) t[(x & 31) | ((z & 31) << 5)] = 0
  }

  tile(key: number): Int32Array | undefined { return this.tiles.get(key) }

  clear(): void { this.tiles.clear() }
}
