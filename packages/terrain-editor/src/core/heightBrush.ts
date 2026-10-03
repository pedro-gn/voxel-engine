import { HEIGHT_SCALE, TILE, type TerrainDoc, type TerrainLayers } from '@elovox/terrain'
import { brushWeight, type BrushSettings } from './brush.ts'
import { TileWriter, replaceLayer } from './layerWriter.ts'
import type { TerrainSampler } from './sampler.ts'

export type HeightTool = 'raise' | 'smooth' | 'flatten'
export const HEIGHT_TOOLS: readonly HeightTool[] = ['raise', 'smooth', 'flatten']

const MIN = -32768, MAX = 32767

export interface HeightDab {
  tool: HeightTool
  /** Brush centre in blocks. */
  x: number
  z: number
  settings: BrushSettings
  /** raise: lower instead. */
  invert?: boolean
  /** flatten: the height to level to (heightAt where the stroke began). */
  target?: number
}

const writer = (doc: TerrainDoc) => new TileWriter(doc.layers.height?.tiles, TILE, (n) => new Int16Array(n))

/** The ground height of the column under (x, z): before the height layer, plus the layer. */
export function heightAt(doc: TerrainDoc, sampler: TerrainSampler, x: number, z: number): number {
  const ix = Math.min(doc.size[0] - 1, Math.max(0, Math.floor(x)))
  const iz = Math.min(doc.size[1] - 1, Math.max(0, Math.floor(z)))
  return sampler.heights(doc, ix, iz, 1, 1)[0]! + writer(doc).get(ix, iz) / HEIGHT_SCALE
}

/** One dab of the height brush: the new layers, sharing every untouched tile; `doc.layers` itself if nothing changed. */
export function heightDab(doc: TerrainDoc, sampler: TerrainSampler, dab: HeightDab): TerrainLayers {
  const [sx, sz] = doc.size
  const r = dab.settings.radius
  const x0 = Math.max(0, Math.floor(dab.x - r)), x1 = Math.min(sx - 1, Math.floor(dab.x + r))
  const z0 = Math.max(0, Math.floor(dab.z - r)), z1 = Math.min(sz - 1, Math.floor(dab.z + r))
  if (x0 > x1 || z0 > z1) return doc.layers
  // One column of margin: smoothing reads each column's neighbours.
  const px0 = Math.max(0, x0 - 1), pz0 = Math.max(0, z0 - 1), px1 = Math.min(sx - 1, x1 + 1), pz1 = Math.min(sz - 1, z1 + 1)
  const pw = px1 - px0 + 1
  const tiles = writer(doc)
  const ground = sampler.heights(doc, px0, pz0, pw, pz1 - pz0 + 1)
  const H = (x: number, z: number) => ground[(x - px0) + (z - pz0) * pw]! + tiles.get(x, z) / HEIGHT_SCALE
  const writes: number[] = [] // x, z, value; applied after every read, so smoothing reads the old heights
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    const w = brushWeight(Math.hypot(x + 0.5 - dab.x, z + 0.5 - dab.z), dab.settings)
    if (w <= 0) continue
    const h = H(x, z)
    let delta: number
    if (dab.tool === 'raise') delta = dab.invert ? -w : w
    else if (dab.tool === 'flatten') delta = w * ((dab.target ?? h) - h)
    else {
      let sum = 0, n = 0
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, nz = z + dz
        if (nx < px0 || nx > px1 || nz < pz0 || nz > pz1) continue
        sum += H(nx, nz)
        n++
      }
      delta = w * (sum / n - h)
    }
    const old = tiles.get(x, z)
    const v = Math.min(MAX, Math.max(MIN, Math.round(old + delta * HEIGHT_SCALE)))
    if (v !== old) writes.push(x, z, v)
  }
  for (let i = 0; i < writes.length; i += 3) tiles.set(writes[i]!, writes[i + 1]!, writes[i + 2]!)
  return tiles.changed ? replaceLayer(doc.layers, { height: tiles.result() }) : doc.layers
}
