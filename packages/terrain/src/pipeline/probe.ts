import { surfaceBlock } from '../biomes/biomes.ts'
import { fillCells, slopeAt } from './cells.ts'
import type { CompiledTerrain } from './compile.ts'
import { VolumeField } from './volume.ts'

export interface ProbeResult {
  /** y of the highest solid voxel, or -1 for an empty column. */
  top: number
  biome: number
  slope: number
  /** Effective water level (river/lake/sea): non-solid voxels below it are water. */
  water: number
  /** Surface block at `top` (before features). */
  block: number
}

export function newProbe(): ProbeResult { return { top: -1, biome: 0, slope: 0, water: 0, block: 0 } }

/** One column through stages 1–4 of the pipeline, exactly as generateRegion would build it. */
export function probe(t: CompiledTerrain, x: number, z: number, out: ProbeResult): void {
  const g = fillCells(t, x - 1, z - 1, 3, 3)
  const solid = new Uint8Array(t.height)
  new VolumeField(t, x, z, 1, 1).column(x, z, g.top[4]!, solid)
  let top = t.height - 1
  while (top >= 0 && !solid[top]) top--
  const water = Math.max(g.water[4]!, t.seaLevel)
  out.top = top
  out.biome = g.biome[4]!
  out.slope = slopeAt(g, 4)
  out.water = water
  out.block = top < 0 ? 0 : surfaceBlock(t.biomes[out.biome]!, t.blocks.fill, {
    depth: 0, slope: out.slope, y: top,
    underwater: top + 1 < water,
    wetRef: Math.max(g.wet[4]!, t.seaLevel),
    ceiling: top > 0 && !solid[top - 1] && top - 1 >= water,
  })
}
