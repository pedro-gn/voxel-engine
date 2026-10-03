import type { BiomeTile, DensityBrick, HeightTile, TerrainLayers } from '../doc/types.ts'
import { BIOME_TILE, BRICK_SAMPLES, BRICK_SPACING, BRICK_SPAN, DENSITY_SCALE, HEIGHT_SCALE, TILE, brickKey, tileKey } from './tiles.ts'

const anyNonZero = (v: ArrayLike<number>) => { for (let i = 0; i < v.length; i++) if (v[i] !== 0) return true; return false }

/** Height delta per column, added after every height op. Tiles can be replaced (engine.terrain.patch). */
export class HeightLayer {
  private readonly tiles = new Map<number, Int16Array>()
  constructor(tiles: readonly HeightTile[] = []) { for (const t of tiles) this.set(t.x, t.z, t.values) }
  get empty(): boolean { return this.tiles.size === 0 }
  /** Height delta in blocks at a column inside the world; 0 where unpainted. */
  at(x: number, z: number): number {
    const t = this.tiles.get(tileKey(Math.floor(x / TILE), Math.floor(z / TILE)))
    return t ? t[(x & (TILE - 1)) + (z & (TILE - 1)) * TILE]! / HEIGHT_SCALE : 0
  }
  /** Replaces a tile; null or all zeros removes it. */
  set(x: number, z: number, values: Int16Array | null): void {
    if (values && anyNonZero(values)) this.tiles.set(tileKey(x, z), values)
    else this.tiles.delete(tileKey(x, z))
  }
}

/** Biome index per 4 × 4 columns, or -1 where unpainted. */
export class BiomeLayer {
  private readonly tiles = new Map<number, Uint8Array>()
  constructor(tiles: readonly BiomeTile[] = []) { for (const t of tiles) this.set(t.x, t.z, t.values) }
  get empty(): boolean { return this.tiles.size === 0 }
  at(x: number, z: number): number {
    const t = this.tiles.get(tileKey(Math.floor(x / TILE), Math.floor(z / TILE)))
    if (!t) return -1
    const cx = (x & (TILE - 1)) >> 2, cz = (z & (TILE - 1)) >> 2
    return t[cx + cz * BIOME_TILE]! - 1
  }
  set(x: number, z: number, values: Uint8Array | null): void {
    if (values && anyNonZero(values)) this.tiles.set(tileKey(x, z), values)
    else this.tiles.delete(tileKey(x, z))
  }
}

interface Bounds { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }

/** Sparse density sculpt: trilinear over a global 2-block sample grid; missing samples are 0. */
export class DensityLayer {
  private readonly bricks = new Map<number, { x: number; y: number; z: number; values: Int8Array }>()
  private boundsCache: Bounds[] | null = null
  constructor(bricks: readonly DensityBrick[] = []) { for (const b of bricks) this.set(b.x, b.y, b.z, b.values) }

  get empty(): boolean { return this.bricks.size === 0 }

  set(x: number, y: number, z: number, values: Int8Array | null): void {
    if (values && anyNonZero(values)) this.bricks.set(brickKey(x, y, z), { x, y, z, values })
    else this.bricks.delete(brickKey(x, y, z))
    this.boundsCache = null
  }

  /** Block-space bounds of every brick, padded by one sample spacing for the trilinear reach. */
  get bounds(): readonly Bounds[] {
    if (!this.boundsCache) {
      this.boundsCache = [...this.bricks.values()].map((b) => ({
        x0: b.x * BRICK_SPAN - BRICK_SPACING, y0: b.y * BRICK_SPAN - BRICK_SPACING, z0: b.z * BRICK_SPAN - BRICK_SPACING,
        x1: (b.x + 1) * BRICK_SPAN, y1: (b.y + 1) * BRICK_SPAN, z1: (b.z + 1) * BRICK_SPAN,
      }))
    }
    return this.boundsCache
  }

  /** Whether any brick can affect the columns in [x0, x1] × [z0, z1]. */
  touches(x0: number, z0: number, x1: number, z1: number): boolean {
    return this.bounds.some((b) => b.x0 <= x1 && b.x1 >= x0 && b.z0 <= z1 && b.z1 >= z0)
  }

  /** Density delta in blocks at a voxel. */
  sample(x: number, y: number, z: number): number {
    const gx = x / BRICK_SPACING, gy = y / BRICK_SPACING, gz = z / BRICK_SPACING
    const ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz)
    const fx = gx - ix, fy = gy - iy, fz = gz - iz
    let v = 0
    for (let c = 0; c < 8; c++) {
      const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1
      const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz)
      if (w > 0) v += w * this.at(ix + dx, iy + dy, iz + dz)
    }
    return v / DENSITY_SCALE
  }

  private at(sx: number, sy: number, sz: number): number {
    if (sx < 0 || sy < 0 || sz < 0) return 0 // keys of negative bricks would collide with real ones
    const b = this.bricks.get(brickKey(Math.floor(sx / BRICK_SAMPLES), Math.floor(sy / BRICK_SAMPLES), Math.floor(sz / BRICK_SAMPLES)))
    if (!b) return 0
    const lx = sx & (BRICK_SAMPLES - 1), ly = sy & (BRICK_SAMPLES - 1), lz = sz & (BRICK_SAMPLES - 1)
    return b.values[lx + lz * BRICK_SAMPLES + ly * BRICK_SAMPLES * BRICK_SAMPLES]!
  }
}

export interface CompiledLayers { heightLayer: HeightLayer; biomeLayer: BiomeLayer; densityLayer: DensityLayer }

export function compileLayers(l: TerrainLayers): CompiledLayers {
  return { heightLayer: new HeightLayer(l.height?.tiles), biomeLayer: new BiomeLayer(l.biome?.tiles), densityLayer: new DensityLayer(l.density?.bricks) }
}
