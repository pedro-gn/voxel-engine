import { surfaceBlock, type SurfaceInput } from '../biomes/biomes.ts'
import { fillCells, slopeAt } from './cells.ts'
import type { CompiledTerrain } from './compile.ts'
import { VolumeField } from './volume.ts'

export interface RegionOptions {
  /** Stamp trees and rocks. Default true. */
  features?: boolean
}

/**
 * Generates the voxels of columns [x0, x0 + w) × [z0, z0 + d), full height, into `out`
 * (index lx + lz * w + y * w * d; for a 32 × 32 column that is the engine's column layout).
 * Pure: the same terrain gives the same voxels for a voxel whatever rectangle contains it.
 */
export function generateRegion(t: CompiledTerrain, x0: number, z0: number, w: number, d: number, out: Uint16Array, o: RegionOptions = {}): void {
  const H = t.height
  if (out.length !== w * d * H) throw new RangeError(`region buffer has ${out.length} voxels, expected ${w * d * H}`)
  const g = fillCells(t, x0 - 1, z0 - 1, w + 2, d + 2)
  const field = new VolumeField(t, x0, z0, w, d)
  const solid = new Uint8Array(H)
  const input: SurfaceInput = { depth: 0, slope: 0, y: 0, underwater: false, wetRef: 0, ceiling: false }
  const layer = w * d
  for (let lz = 0; lz < d; lz++) for (let lx = 0; lx < w; lx++) {
    const x = x0 + lx, z = z0 + lz
    const gi = (lx + 1) + (lz + 1) * g.w
    field.column(x, z, g.top[gi]!, solid)
    const water = Math.max(g.water[gi]!, t.seaLevel)
    const biome = t.biomes[g.biome[gi]!]!
    input.slope = slopeAt(g, gi)
    input.wetRef = Math.max(g.wet[gi]!, t.seaLevel)
    let depth = -1, aboveWater = false
    for (let y = H - 1; y >= 0; y--) {
      const i = lx + lz * w + y * layer
      if (!solid[y]) {
        const wet = y < water
        out[i] = wet ? t.blocks.water : 0
        depth = -1
        aboveWater = wet
        continue
      }
      depth++
      input.depth = depth
      input.y = y
      input.underwater = aboveWater
      input.ceiling = y > 0 && !solid[y - 1] && y - 1 >= water
      out[i] = surfaceBlock(biome, t.blocks.fill, input)
    }
  }
}
