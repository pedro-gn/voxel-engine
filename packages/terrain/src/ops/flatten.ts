import { expandRect } from '../geom.ts'
import { blend } from '../shapes/blend.ts'
import { compileShape, newSample, weight } from '../shapes/shape.ts'
import { defineTerrainOp } from './registry.ts'
import { WORLD_TOP, paramsOf, type ParamSchema } from './schema.ts'

const PARAMS = {
  y: { type: 'number', required: true, default: 0, min: 0, max: WORLD_TOP, anchor: 'ground' },
} as const satisfies ParamSchema

/** A flat site at height `y`, blended into the surroundings over the shape's falloff. Default blend 'set'. */
export const flatten = defineTerrainOp({
  type: 'flatten', kind: 'height', defaultBlend: 'set', shapes: ['circle', 'polygon', 'path'], falloff: true, params: PARAMS,
  compile(def) {
    const shape = compileShape(def.shape)
    const { y } = paramsOf(def, PARAMS)
    const mode = def.blend ?? 'set'
    const s = newSample()
    return {
      id: def.id,
      bounds: expandRect(shape.bounds, shape.falloff),
      apply(x, z, cell) {
        shape.sample(x, z, s)
        const w = weight(s, shape.falloff)
        if (w > 0) cell.h = blend(mode, cell.h, y, w)
      },
    }
  },
})
