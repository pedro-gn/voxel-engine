import { expandRect } from '../geom.ts'
import { compileShape, newSample, weight } from '../shapes/shape.ts'
import { checkParamNoise, checkParamNum, noise2Of, param } from './common.ts'
import { defineTerrainOp } from './registry.ts'

/**
 * Paints a biome over an area (where the falloff weight is at least 0.5). `jitter` (blocks) moves the
 * border in and out with noise so it does not follow the shape's straight edges. Changes no height.
 */
export const biome = defineTerrainOp({
  type: 'biome', kind: 'height', defaultBlend: 'set', shapes: ['circle', 'polygon', 'path'],
  validate(c, path, def, ctx) {
    c.str(`${path}.params.biome`, def.params.biome, ctx.biomes)
    checkParamNum(c, path, def, 'jitter', { min: 0, optional: true })
    checkParamNoise(c, path, def)
  },
  compile(def, ctx) {
    const shape = compileShape(def.shape)
    const index = ctx.biomeIndex(String(def.params.biome))
    const jitter = param(def, 'jitter', 0)
    const noise = noise2Of(def, 'noise', { scale: 48, octaves: 3 }, ctx.seed)
    const s = newSample()
    return {
      id: def.id,
      bounds: expandRect(shape.bounds, shape.falloff + jitter),
      apply(x, z, cell) {
        shape.sample(x, z, s)
        if (jitter > 0) s.dist += jitter * (noise(x, z) * 2 - 1)
        if (weight(s, shape.falloff) >= 0.5) cell.biome = index
      },
    }
  },
})
