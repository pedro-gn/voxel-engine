import { TILES } from './materials.ts'
import { rng } from './raster.ts'
import { shade } from './shade.ts'

/** Tiles greedy meshing may repeat side by side, so they must tile on that axis. */
export const SEAMLESS_X: readonly string[] = ['stone', 'dirt', 'grass_top', 'grass_side', 'sand', 'log_side', 'planks', 'leaves', 'rock', 'glass', 'water']
export const SEAMLESS_Y: readonly string[] = ['stone', 'dirt', 'grass_top', 'sand', 'log_side', 'planks', 'leaves', 'rock', 'glass', 'water']

/** Every sandbox tile as 64×64 RGBA bytes. Deterministic. */
export function paintTiles(): Record<string, Uint8ClampedArray> {
  const out: Record<string, Uint8ClampedArray> = {}
  TILES.forEach(([name, paintTile, opts], k) => { out[name] = shade(paintTile(rng(1000 + k)), { seed: 500 + k, ...opts }) })
  return out
}
