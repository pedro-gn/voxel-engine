import { BRICK_SAMPLES, BRICK_SPACING, BRICK_SPAN, DENSITY_SCALE, type TerrainDoc, type TerrainLayers } from '@elovox/terrain'
import { brushWeight, type BrushSettings } from './brush.ts'
import { BrickWriter, replaceLayer } from './layerWriter.ts'
import type { TerrainSampler } from './sampler.ts'

export type DensityTool = 'add' | 'smooth'
export const DENSITY_TOOLS: readonly DensityTool[] = ['add', 'smooth']

export interface DensityDab {
  tool: DensityTool
  /** Sphere centre in blocks. */
  x: number
  y: number
  z: number
  settings: BrushSettings
  /** add: carve instead. */
  invert?: boolean
}

/** One dab of the density brush over the 2-block sample grid; `doc.layers` itself if nothing changed. */
export function densityDab(doc: TerrainDoc, sampler: TerrainSampler, dab: DensityDab): TerrainLayers {
  const S = BRICK_SPACING
  const last = (blocks: number) => Math.ceil(blocks / BRICK_SPAN) * BRICK_SAMPLES - 1
  const r = dab.settings.radius
  const lo = (c: number) => Math.max(0, Math.ceil((c - r) / S))
  const x0 = lo(dab.x), x1 = Math.min(last(doc.size[0]), Math.floor((dab.x + r) / S))
  const y0 = lo(dab.y), y1 = Math.min(last(sampler.height), Math.floor((dab.y + r) / S))
  const z0 = lo(dab.z), z1 = Math.min(last(doc.size[1]), Math.floor((dab.z + r) / S))
  if (x0 > x1 || y0 > y1 || z0 > z1) return doc.layers
  const bricks = new BrickWriter(doc.layers.density?.bricks)
  // Smoothing reads the total density with one sample of margin on every side.
  const nx = x1 - x0 + 3, ny = y1 - y0 + 3, nz = z1 - z0 + 3
  const D = dab.tool === 'smooth'
    ? sampler.density(doc, { x0: (x0 - 1) * S, y0: (y0 - 1) * S, z0: (z0 - 1) * S, nx, ny, nz, step: S })
    : null
  const at = (i: number, j: number, k: number) => D![(i - x0 + 1) + (k - z0 + 1) * nx + (j - y0 + 1) * nx * nz]!
  const writes: number[] = [] // sx, sy, sz, value
  for (let j = y0; j <= y1; j++) for (let k = z0; k <= z1; k++) for (let i = x0; i <= x1; i++) {
    const w = brushWeight(Math.hypot(i * S - dab.x, j * S - dab.y, k * S - dab.z), dab.settings)
    if (w <= 0) continue
    let delta: number // blocks
    if (dab.tool === 'add') delta = (dab.invert ? -1 : 1) * w * S
    else {
      let sum = 0
      for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) sum += at(i + di, j + dj, k + dk)
      delta = w * (sum / 27 - at(i, j, k))
    }
    const old = bricks.get(i, j, k)
    const v = Math.min(127, Math.max(-128, Math.round(old + delta * DENSITY_SCALE)))
    if (v !== old) writes.push(i, j, k, v)
  }
  for (let n = 0; n < writes.length; n += 4) bricks.set(writes[n]!, writes[n + 1]!, writes[n + 2]!, writes[n + 3]!)
  return bricks.changed ? replaceLayer(doc.layers, { density: bricks.result() }) : doc.layers
}
