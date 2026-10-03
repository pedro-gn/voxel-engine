import { BIOME_CELL, BIOME_TILE, type TerrainDoc, type TerrainLayers } from '@elovox/terrain'
import { TileWriter, replaceLayer } from './layerWriter.ts'

export interface BiomeDab {
  /** Brush centre in blocks. */
  x: number
  z: number
  radius: number
  /** 0 erases; k paints biomes[k - 1]. */
  value: number
}

/** One dab of the biome brush: every 4 × 4 cell whose centre lies within the radius takes `value`. */
export function biomeDab(doc: TerrainDoc, dab: BiomeDab): TerrainLayers {
  const cellsX = Math.ceil(doc.size[0] / BIOME_CELL), cellsZ = Math.ceil(doc.size[1] / BIOME_CELL)
  const r = dab.radius
  const c0 = Math.max(0, Math.floor((dab.x - r) / BIOME_CELL)), c1 = Math.min(cellsX - 1, Math.floor((dab.x + r) / BIOME_CELL))
  const k0 = Math.max(0, Math.floor((dab.z - r) / BIOME_CELL)), k1 = Math.min(cellsZ - 1, Math.floor((dab.z + r) / BIOME_CELL))
  if (c0 > c1 || k0 > k1) return doc.layers
  const tiles = new TileWriter(doc.layers.biome?.tiles, BIOME_TILE, (n) => new Uint8Array(n))
  const half = BIOME_CELL / 2
  for (let cz = k0; cz <= k1; cz++) for (let cx = c0; cx <= c1; cx++) {
    if (Math.hypot(cx * BIOME_CELL + half - dab.x, cz * BIOME_CELL + half - dab.z) > r) continue
    if (tiles.get(cx, cz) !== dab.value) tiles.set(cx, cz, dab.value)
  }
  return tiles.changed ? replaceLayer(doc.layers, { biome: tiles.result() }) : doc.layers
}
