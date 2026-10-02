import type { Override } from '../protocol.ts'
import type { Layout } from '../world/layout.ts'

export function chunksTouching(layout: Layout, x: number, y: number, z: number): number[] {
  const out = new Set<number>()
  for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const nx = x + dx, ny = y + dy, nz = z + dz
    if (!layout.inBounds(nx, ny, nz)) continue
    out.add(layout.chunkOf(nx, ny, nz))
  }
  return [...out].sort((a, b) => a - b)
}

interface Ghost { seq: number; x: number; y: number; z: number; voxel: number }

/** Predicted edits shown on the main thread until the sim acks them. */
export class GhostEdits {
  private readonly layout: Layout
  private readonly byPos = new Map<number, Ghost>()
  private readonly bySeq = new Map<number, number[]>()

  constructor(layout: Layout) { this.layout = layout }

  get size(): number { return this.byPos.size }

  add(seq: number, x: number, y: number, z: number, voxel: number): number[] {
    if (!this.layout.inBounds(x, y, z)) return [] // would alias onto an in-bounds voxel
    const key = this.layout.voxelIndex(x, y, z)
    this.byPos.set(key, { seq, x, y, z, voxel })
    const list = this.bySeq.get(seq)
    if (list) list.push(key)
    else this.bySeq.set(seq, [key])
    return chunksTouching(this.layout, x, y, z)
  }

  get(x: number, y: number, z: number): number | undefined {
    if (this.byPos.size === 0 || !this.layout.inBounds(x, y, z)) return undefined
    return this.byPos.get(this.layout.voxelIndex(x, y, z))?.voxel
  }

  resolve(seq: number): number[] {
    const keys = this.bySeq.get(seq)
    if (!keys) return []
    this.bySeq.delete(seq)
    const chunks = new Set<number>()
    for (const key of keys) {
      const g = this.byPos.get(key)
      if (!g || g.seq !== seq) continue // a newer edit owns this voxel now
      this.byPos.delete(key)
      for (const c of chunksTouching(this.layout, g.x, g.y, g.z)) chunks.add(c)
    }
    return [...chunks].sort((a, b) => a - b)
  }

  overridesFor(chunk: number): Override[] {
    const [cx, cy, cz] = this.layout.chunkCoords(chunk)
    const out: Override[] = []
    for (const g of this.byPos.values()) {
      const lx = g.x - cx * 32, ly = g.y - cy * 32, lz = g.z - cz * 32
      if (lx >= -1 && lx <= 32 && ly >= -1 && ly <= 32 && lz >= -1 && lz <= 32) out.push([g.x, g.y, g.z, g.voxel])
    }
    return out
  }
}
