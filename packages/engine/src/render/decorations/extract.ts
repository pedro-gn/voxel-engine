import type { MeshTables } from '../../mesh/tables.ts'
import { valueNoise2 } from '../../sim/generator.ts'
import { hash32 } from '../../sim/rng.ts'
import { PAD, padIndex, type ChunkSnapshot } from '../../world/reader.ts'
import { AIR, voxelId, voxelState } from '../../world/voxel.ts'

export const EDGE = { PX: 1, NX: 2, PZ: 4, NZ: 8 } as const
const DENSITY_SEED = 0x51d3e
const FLOWER_SEED = 0x6f1e7
const PATCH_SEED = 0x2a7c1
const UP = PAD * PAD
const SIDES: readonly (readonly [number, number])[] = [[1, EDGE.PX], [-1, EDGE.NX], [PAD, EDGE.PZ], [-PAD, EDGE.NZ]]

export function packInstance(lx: number, ly: number, lz: number, edge: number, sky: number, blk: number): number {
  return (lx | (ly << 5) | (lz << 10) | (edge << 15) | (sky << 19) | (blk << 23)) >>> 0
}
export function unpackInstance(a: number) {
  return { lx: a & 31, ly: (a >>> 5) & 31, lz: (a >>> 10) & 31, edge: (a >>> 15) & 15, sky: (a >>> 19) & 15, blk: (a >>> 23) & 15 }
}

/** Growable buffer of 2-word instances. */
export class InstanceBuilder {
  private data: Uint32Array
  private n = 0
  constructor(initial = 256) { this.data = new Uint32Array(initial * 2) }
  get count(): number { return this.n }
  push(a: number, b: number): void {
    if ((this.n + 1) * 2 > this.data.length) {
      const d = new Uint32Array(this.data.length * 2)
      d.set(this.data)
      this.data = d
    }
    this.data[this.n * 2] = a
    this.data[this.n * 2 + 1] = b
    this.n++
  }
  build(): Uint32Array | null { return this.n === 0 ? null : this.data.slice(0, this.n * 2) }
  reset(): void { this.n = 0 }
}

/** Flower probability for a world column: `chance` inside a patch, ramping to 0 outside it. Deterministic. */
export function flowerChanceAt(chance: number, patchScale: number, wx: number, wz: number): number {
  const patch = valueNoise2(PATCH_SEED, wx / patchScale, wz / patchScale)
  return chance * Math.min(1, Math.max(0, (patch - 0.45) / 0.25))
}

/** Appends decoration instances for one snapshot. (ox, oy, oz) is the chunk's world origin. */
export function extractDecorations(
  s: ChunkSnapshot, t: MeshTables, ox: number, oy: number, oz: number, grass: InstanceBuilder, flowers: InstanceBuilder,
): void {
  const d = t.deco
  for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
    const pi = padIndex(x + 1, y + 1, z + 1)
    const k = d.byBlock[voxelId(s.voxels[pi]!)]!
    if (k === 0) continue
    if (voxelId(s.voxels[pi + UP]!) !== AIR) continue
    const wx = ox + x, wy = oy + y, wz = oz + z
    const dens = d.stateDensity[(k - 1) * 4 + (voxelState(s.voxels[pi]!) & 3)]!
    if (dens < 1 && hash32(DENSITY_SEED, wx, wy, wz) / 4294967296 >= dens) continue
    let edge = 0
    for (const [off, bit] of SIDES) if (!t.opaque[voxelId(s.voxels[pi + off]!)]) edge |= bit
    const l = s.light[pi + UP]!
    const a = packInstance(x, y, z, edge, l & 15, l >> 4)
    const di = k - 1
    if (d.grass[di]) grass.push(a, di)
    const colors = d.flowerColors[di]!
    if (colors === 0) continue
    const p = flowerChanceAt(d.flowerChance[di]!, d.patchScale[di]!, wx, wz)
    if (p > 0 && hash32(FLOWER_SEED, wx, wy, wz) / 4294967296 < p) {
      flowers.push(a, di | ((hash32(FLOWER_SEED + 1, wx, wy, wz) % colors) << 8))
    }
  }
}
