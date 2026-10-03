import { expandRect } from '../geom.ts'
import { makeNoise2 } from '../noise/def.ts'
import { blend } from '../shapes/blend.ts'
import { compileShape, newSample, weight } from '../shapes/shape.ts'
import { defineTerrainOp } from './registry.ts'
import { paramsOf, type ParamSchema } from './schema.ts'

const PARAMS = {
  amplitude: { type: 'number', required: true, default: 12, min: 0, range: [0, 64] },
  offset: { type: 'number', default: 0, range: [-32, 32] },
  noise: { type: 'noise', default: { scale: 64 } },
} as const satisfies ParamSchema

/**
 * Procedural fill inside an area: value = offset + amplitude * noise (noise in [0, 1]).
 * Default blend 'add' (bumps on top of the ground); with 'min' and a low offset it lowers an area
 * into a sea floor; with 'set' it replaces the ground.
 */
export const hills = defineTerrainOp({
  type: 'hills', kind: 'height', defaultBlend: 'add', shapes: ['circle', 'polygon', 'path'], falloff: true, params: PARAMS,
  compile(def, ctx) {
    const shape = compileShape(def.shape)
    const p = paramsOf(def, PARAMS)
    const noise = makeNoise2(p.noise, ctx.seed)
    const mode = def.blend ?? 'add'
    const s = newSample()
    return {
      id: def.id,
      bounds: expandRect(shape.bounds, shape.falloff),
      apply(x, z, cell) {
        shape.sample(x, z, s)
        const w = weight(s, shape.falloff)
        if (w > 0) cell.h = blend(mode, cell.h, p.offset + p.amplitude * noise(x, z), w)
      },
    }
  },
})
