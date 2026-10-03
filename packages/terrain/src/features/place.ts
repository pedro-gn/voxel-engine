import { hash2, unit } from '../noise/hash.ts'
import type { CompiledTerrain } from '../pipeline/compile.ts'
import { newProbe, probe } from '../pipeline/probe.ts'
import { mulberry32, type Put } from './rand.ts'
import { stampRock } from './rocks.ts'
import { MAX_TREE_HEIGHT, stampTree } from './trees.ts'

/** One feature candidate per FEATURE_CELL × FEATURE_CELL columns. */
export const FEATURE_CELL = 8
/** No feature reaches farther than this from its anchor column (trees ≤ 5, rocks ≤ 7). */
export const FEATURE_REACH = 7

const JITTER_SEED = 0x6a09e667
const ROLL_SEED = 0x3c6ef372
const SHAPE_SEED = 0x510e527f

/**
 * Stamps every tree and rock that reaches [x0, x0 + w) × [z0, z0 + d) into `out` (generateRegion's
 * layout). Candidates come from a global jittered grid and are visited in global (gz, gx) order, and
 * each one probes its own column, so overlapping stamps resolve the same way in any region.
 */
export function stampFeatures(t: CompiledTerrain, x0: number, z0: number, w: number, d: number, out: Uint16Array): void {
  const H = t.height
  const layer = w * d
  const put: Put = (x, y, z, v, overwrite) => {
    if (x < x0 || x >= x0 + w || z < z0 || z >= z0 + d || y < 0 || y >= H) return
    const i = (x - x0) + (z - z0) * w + y * layer
    if (overwrite || out[i] === 0) out[i] = v
  }
  const p = newProbe()
  const gx0 = Math.floor((x0 - FEATURE_REACH) / FEATURE_CELL), gx1 = Math.floor((x0 + w - 1 + FEATURE_REACH) / FEATURE_CELL)
  const gz0 = Math.floor((z0 - FEATURE_REACH) / FEATURE_CELL), gz1 = Math.floor((z0 + d - 1 + FEATURE_REACH) / FEATURE_CELL)
  for (let gz = gz0; gz <= gz1; gz++) for (let gx = gx0; gx <= gx1; gx++) {
    const j = hash2(t.seed ^ JITTER_SEED, gx, gz)
    const px = gx * FEATURE_CELL + (j & 7), pz = gz * FEATURE_CELL + ((j >>> 3) & 7)
    if (px < 0 || pz < 0 || px >= t.sizeX || pz >= t.sizeZ) continue
    const roll = unit(hash2(t.seed ^ ROLL_SEED, gx, gz))
    probe(t, px, pz, p)
    if (p.top < 0 || p.top + 1 < p.water) continue // empty column or under water
    const biome = t.biomes[p.biome]!
    const treeChance = biome.trees?.density ?? 0
    const rnd = mulberry32(hash2(t.seed ^ SHAPE_SEED, gx, gz))
    if (roll < treeChance) {
      const trees = biome.trees!
      if (p.slope > 1 || !trees.on.has(p.block) || p.top + 2 + MAX_TREE_HEIGHT >= H) continue
      const kind = trees.kinds[Math.floor(rnd() * trees.kinds.length)]!
      stampTree(kind, px, p.top + 1, pz, rnd, t.blocks, put)
    } else if (biome.rocks && roll < treeChance + biome.rocks.density) {
      if (p.slope > 2) continue
      const [r0, r1] = biome.rocks.size
      stampRock(px, p.top, pz, r0 + rnd() * (r1 - r0), rnd, t.blocks.rock, put)
    }
  }
}
