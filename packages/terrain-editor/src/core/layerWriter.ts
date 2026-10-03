import { BRICK_SAMPLES, brickKey, tileKey, type BiomeTile, type DensityBrick, type HeightTile, type TerrainLayers } from '@elovox/terrain'

interface Tile<V> { x: number; z: number; values: V }

const anyNonZero = (v: ArrayLike<number>) => { for (let i = 0; i < v.length; i++) if (v[i] !== 0) return true; return false }

/**
 * Copy-on-write access to one 2D layer for one edit, in sample coordinates (columns for height, cells
 * for biome). The first write to a tile copies it (or creates it zeroed); later writes reuse the copy.
 * Tiles never written stay shared with the input, and the input is never mutated.
 */
export class TileWriter<V extends Int16Array | Uint8Array> {
  private readonly tiles = new Map<number, Tile<V>>()
  private readonly own = new Set<number>()
  private readonly side: number
  private readonly make: (n: number) => V

  constructor(tiles: readonly Tile<V>[] | undefined, side: number, make: (n: number) => V) {
    this.side = side
    this.make = make
    for (const t of tiles ?? []) this.tiles.set(tileKey(t.x, t.z), t)
  }

  /** Whether any tile was written. */
  get changed(): boolean { return this.own.size > 0 }

  get(i: number, j: number): number {
    const s = this.side
    const t = this.tiles.get(tileKey(Math.floor(i / s), Math.floor(j / s)))
    return t ? t.values[(i % s) + (j % s) * s]! : 0
  }

  set(i: number, j: number, v: number): void {
    const s = this.side
    const x = Math.floor(i / s), z = Math.floor(j / s), k = tileKey(x, z)
    let t = this.tiles.get(k)
    if (!t || !this.own.has(k)) {
      if (!t && v === 0) return
      const values = this.make(s * s)
      if (t) values.set(t.values)
      t = { x, z, values }
      this.tiles.set(k, t)
      this.own.add(k)
    }
    t.values[(i % s) + (j % s) * s] = v
  }

  /** The new tile list: sorted by z then x, all-zero tiles dropped; undefined when empty. */
  result(): Tile<V>[] | undefined {
    const out = [...this.tiles.values()].filter((t) => anyNonZero(t.values))
    out.sort((a, b) => a.z - b.z || a.x - b.x)
    return out.length > 0 ? out : undefined
  }
}

/** Copy-on-write access to the density bricks for one edit, by global sample coordinates. */
export class BrickWriter {
  private readonly bricks = new Map<number, DensityBrick>()
  private readonly own = new Set<number>()

  constructor(bricks: readonly DensityBrick[] | undefined) {
    for (const b of bricks ?? []) this.bricks.set(brickKey(b.x, b.y, b.z), b)
  }

  get changed(): boolean { return this.own.size > 0 }

  get(sx: number, sy: number, sz: number): number {
    const S = BRICK_SAMPLES
    const b = this.bricks.get(brickKey(Math.floor(sx / S), Math.floor(sy / S), Math.floor(sz / S)))
    return b ? b.values[(sx % S) + (sz % S) * S + (sy % S) * S * S]! : 0
  }

  set(sx: number, sy: number, sz: number, v: number): void {
    const S = BRICK_SAMPLES
    const x = Math.floor(sx / S), y = Math.floor(sy / S), z = Math.floor(sz / S), k = brickKey(x, y, z)
    let b = this.bricks.get(k)
    if (!b || !this.own.has(k)) {
      if (!b && v === 0) return
      const values = new Int8Array(S * S * S)
      if (b) values.set(b.values)
      b = { x, y, z, values }
      this.bricks.set(k, b)
      this.own.add(k)
    }
    b.values[(sx % S) + (sz % S) * S + (sy % S) * S * S] = v
  }

  /** The new brick list: sorted by y, z, x, all-zero bricks dropped; undefined when empty. */
  result(): DensityBrick[] | undefined {
    const out = [...this.bricks.values()].filter((b) => anyNonZero(b.values))
    out.sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)
    return out.length > 0 ? out : undefined
  }
}

/** New lists for some layers; a layer given as undefined is removed. */
export interface LayerLists { height?: HeightTile[] | undefined; biome?: BiomeTile[] | undefined; density?: DensityBrick[] | undefined }

/** `layers` with the given layers replaced. */
export function replaceLayer(layers: TerrainLayers, lists: LayerLists): TerrainLayers {
  const out: TerrainLayers = { ...layers }
  if ('height' in lists) { if (lists.height) out.height = { tiles: lists.height }; else delete out.height }
  if ('biome' in lists) { if (lists.biome) out.biome = { tiles: lists.biome }; else delete out.biome }
  if ('density' in lists) { if (lists.density) out.density = { bricks: lists.density }; else delete out.density }
  return out
}
