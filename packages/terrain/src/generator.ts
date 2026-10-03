import type { GeneratorInfo, GeneratorModule } from '@elovox/engine/sim-worker'
import { TerrainDocError, validateTerrainDoc } from './doc/validate.ts'
import { builtinOps } from './ops/builtin.ts'
import type { OpRegistry } from './ops/registry.ts'
import { compileTerrain, type CompiledTerrain } from './pipeline/compile.ts'
import { generateRegion } from './pipeline/region.ts'
import { applyPatch, checkPatch, type TerrainPatch } from './layers/patch.ts'
import type { LayerLimits } from './layers/tiles.ts'

export interface TerrainGeneratorOptions {
  /** Op types documents may use. Default: the built-in ops. Add custom ops with `builtinOps.with(...)`. */
  ops?: OpRegistry
}

/**
 * A GeneratorModule that builds the world from a TerrainDoc. The engine hands it the document through
 * configure() (createEngine's `terrain` option, then engine.terrain.setDocument). Use the same
 * generator in the sim worker and the generation workers. `patch` applies layer patches (engine.terrain.patch, TerrainPatch).
 */
export function createTerrainGenerator(o: TerrainGeneratorOptions = {}): GeneratorModule {
  const ops = o.ops ?? builtinOps
  let terrain: CompiledTerrain | null = null
  let limits: LayerLimits | null = null
  return {
    configure(doc: unknown, info: GeneratorInfo) {
      const r = validateTerrainDoc(doc, { ops, worldHeight: info.size[1] })
      if (!r.ok) throw new TerrainDocError(r.errors)
      const [sx, sy, sz] = info.size
      if (r.doc.size[0] !== sx || r.doc.size[1] !== sz) {
        throw new Error(`terrain document size [${r.doc.size.join(', ')}] does not match the world's x, z [${sx}, ${sz}]`)
      }
      // Compile before replacing: a document that fails here leaves the previous one in force.
      terrain = compileTerrain(r.doc, { seed: info.seed, height: sy, id: (name) => info.id(name), ops })
      limits = { sizeX: sx, sizeZ: sz, height: sy, biomeCount: r.doc.biomes.length }
    },
    patch(p: unknown) {
      if (!terrain || !limits) throw new Error('the terrain generator has no document to patch')
      const errors = checkPatch(p, limits)
      if (errors.length > 0) throw new Error(`invalid terrain patch:\n  - ${errors.join('\n  - ')}`)
      applyPatch(terrain, p as TerrainPatch)
    },
    generateColumn(ctx, cx, cz) {
      if (!terrain) throw new Error('the terrain generator has no document: pass `terrain` to createEngine')
      generateRegion(terrain, cx * 32, cz * 32, 32, 32, ctx.column)
    },
  }
}

/** The terrain generator with the built-in ops. */
export const terrainGenerator = createTerrainGenerator()
