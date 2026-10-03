import type { Cell } from '../ops/registry.ts'
import { TerrainOpError, type CompiledTerrain } from './compile.ts'

/** The 2D stage for a rectangle of columns [x0, x0 + w) × [z0, z0 + d). Index: (x - x0) + (z - z0) * w. */
export interface CellGrid {
  readonly x0: number
  readonly z0: number
  readonly w: number
  readonly d: number
  /** Ground height rounded and clamped to [1, height - 2]: voxels y < top are solid before volume ops. */
  readonly top: Int32Array
  /** Water level from rivers and lakes, or -1. */
  readonly water: Float64Array
  /** Water reference for nearWater rules, or -Infinity. */
  readonly wet: Float64Array
  readonly biome: Int32Array
}

/** Runs base, height ops (in document order), the height layer and biome selection for every column. */
export function fillCells(t: CompiledTerrain, x0: number, z0: number, w: number, d: number): CellGrid {
  const n = w * d
  const h = new Float64Array(n)
  const water = new Float64Array(n).fill(-1)
  const wet = new Float64Array(n).fill(-Infinity)
  const opBiome = new Int32Array(n).fill(-1)
  for (let lz = 0; lz < d; lz++) for (let lx = 0; lx < w; lx++) h[lx + lz * w] = t.base(x0 + lx, z0 + lz)

  const cell: Cell = { h: 0, water: -1, wet: -Infinity, biome: -1 }
  for (const op of t.heightOps) {
    const b = op.bounds
    const xa = Math.max(x0, Math.ceil(b.x0)), xb = Math.min(x0 + w - 1, Math.floor(b.x1))
    const za = Math.max(z0, Math.ceil(b.z0)), zb = Math.min(z0 + d - 1, Math.floor(b.z1))
    if (xa > xb || za > zb) continue
    try {
      for (let z = za; z <= zb; z++) for (let x = xa; x <= xb; x++) {
        const i = (x - x0) + (z - z0) * w
        cell.h = h[i]!; cell.water = water[i]!; cell.wet = wet[i]!; cell.biome = opBiome[i]!
        op.apply(x, z, cell)
        h[i] = cell.h; water[i] = cell.water; wet[i] = cell.wet; opBiome[i] = cell.biome
      }
    } catch (e) {
      throw new TerrainOpError(op.id, `at columns x ${xa}..${xb}, z ${za}..${zb}`, e)
    }
  }

  const top = new Int32Array(n)
  const biome = new Int32Array(n)
  const maxTop = t.height - 2
  for (let lz = 0; lz < d; lz++) for (let lx = 0; lx < w; lx++) {
    const i = lx + lz * w, x = x0 + lx, z = z0 + lz
    const inWorld = x >= 0 && z >= 0 && x < t.sizeX && z < t.sizeZ
    const hh = h[i]! + (inWorld && t.heightLayer ? t.heightLayer.at(x, z) : 0)
    const tp = Math.min(maxTop, Math.max(1, Math.round(hh)))
    top[i] = tp
    const painted = inWorld && t.biomeLayer ? t.biomeLayer.at(x, z) : -1
    biome[i] = painted >= 0 ? painted : opBiome[i]! >= 0 ? opBiome[i]! : t.biomeRule(x, z, tp)
  }
  return { x0, z0, w, d, top, water, wet, biome }
}

/** Rise per block at grid index `i` (not on the grid's border), from its four neighbours' ground heights. */
export function slopeAt(g: CellGrid, i: number): number {
  return Math.max(Math.abs(g.top[i + 1]! - g.top[i - 1]!), Math.abs(g.top[i + g.w]! - g.top[i - g.w]!)) / 2
}
