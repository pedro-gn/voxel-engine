export const CHUNK_SIZE = 32
export const CHUNK_VOLUME = 32768
export type WorldSize = readonly [number, number, number]

export class Layout {
  readonly size: WorldSize
  readonly cx: number
  readonly cy: number
  readonly cz: number
  readonly chunkCount: number
  readonly voxelCount: number

  constructor(size: WorldSize) {
    for (const s of size) {
      if (!Number.isInteger(s) || s <= 0 || s % CHUNK_SIZE !== 0) {
        throw new RangeError(`world size must be positive multiples of 32, got [${size.join(', ')}]`)
      }
    }
    this.size = [size[0], size[1], size[2]]
    this.cx = size[0] >> 5
    this.cy = size[1] >> 5
    this.cz = size[2] >> 5
    this.chunkCount = this.cx * this.cy * this.cz
    this.voxelCount = size[0] * size[1] * size[2]
  }

  inBounds(x: number, y: number, z: number): boolean {
    return Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z) &&
      x >= 0 && y >= 0 && z >= 0 && x < this.size[0] && y < this.size[1] && z < this.size[2]
  }
  chunkInBounds(cx: number, cy: number, cz: number): boolean {
    return cx >= 0 && cy >= 0 && cz >= 0 && cx < this.cx && cy < this.cy && cz < this.cz
  }
  chunkIndex(cx: number, cy: number, cz: number): number {
    return cx + cz * this.cx + cy * this.cx * this.cz
  }
  chunkCoords(ci: number): [number, number, number] {
    const layer = this.cx * this.cz
    const cy = Math.floor(ci / layer)
    const rest = ci - cy * layer
    const cz = Math.floor(rest / this.cx)
    return [rest - cz * this.cx, cy, cz]
  }
  chunkOf(x: number, y: number, z: number): number {
    return this.chunkIndex(x >> 5, y >> 5, z >> 5)
  }
  /** The chunks holding a voxel of the 3 × 3 × 3 box around (x, y, z), sorted: the meshes an edit there can change. */
  chunksAround(x: number, y: number, z: number): number[] {
    const out: number[] = []
    for (let cy = Math.max(0, (y - 1) >> 5); cy <= Math.min(this.cy - 1, (y + 1) >> 5); cy++)
      for (let cz = Math.max(0, (z - 1) >> 5); cz <= Math.min(this.cz - 1, (z + 1) >> 5); cz++)
        for (let cx = Math.max(0, (x - 1) >> 5); cx <= Math.min(this.cx - 1, (x + 1) >> 5); cx++) out.push(this.chunkIndex(cx, cy, cz))
    return out
  }
  voxelIndex(x: number, y: number, z: number): number {
    return x + z * this.size[0] + y * this.size[0] * this.size[2]
  }
  voxelCoords(i: number): [number, number, number] {
    const layer = this.size[0] * this.size[2]
    const y = Math.floor(i / layer)
    const rest = i - y * layer
    const z = Math.floor(rest / this.size[0])
    return [rest - z * this.size[0], y, z]
  }
  static localIndex(lx: number, ly: number, lz: number): number {
    return lx + (lz << 5) + (ly << 10)
  }
}
