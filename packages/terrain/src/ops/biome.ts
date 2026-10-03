import { expandRect } from '../geom.ts'
import { makeNoise2 } from '../noise/def.ts'
import { compileShape, newSample, weight } from '../shapes/shape.ts'
import { defineTerrainOp } from './registry.ts'
import { paramsOf, type ParamSchema } from './schema.ts'

const PARAMS = {
  biome: { type: 'biome' },
  jitter: { type: 'number', default: 0, min: 0, range: [0, 32] },
  noise: { type: 'noise', default: { scale: 48, octaves: 3 } },
} as const satisfies ParamSchema

/**
 * Paints a biome over an area (where the falloff weight is at least 0.5). `jitter` (blocks) moves the
 * border in and out with noise so it does not follow the shape's straight edges. Changes no height.
 */
export const biome = defineTerrainOp({
  type: 'biome', kind: 'height', defaultBlend: 'set', shapes: ['circle', 'polygon', 'path'], falloff: true, params: PARAMS,
  compile(def, ctx) {
    const shape = compileShape(def.shape)
    const p = paramsOf(def, PARAMS)
    const index = ctx.biomeIndex(p.biome)
    const noise = makeNoise2(p.noise, ctx.seed)
    const s = newSample()
    return {
      id: def.id,
      bounds: expandRect(shape.bounds, shape.falloff + p.jitter),
      apply(x, z, cell) {
        shape.sample(x, z, s)
        if (p.jitter > 0) s.dist += p.jitter * (noise(x, z) * 2 - 1)
        if (weight(s, shape.falloff) >= 0.5) cell.biome = index
      },
    }
  },
})
