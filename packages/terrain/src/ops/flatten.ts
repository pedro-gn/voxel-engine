import { expandRect } from '../geom.ts'
import { blend } from '../shapes/blend.ts'
import { compileShape, newSample, weight } from '../shapes/shape.ts'
import { checkParamNum, param } from './common.ts'
import { defineTerrainOp } from './registry.ts'

/** A flat site at height `y`, blended into the surroundings over the shape's falloff. Default blend 'set'. */
export const flatten = defineTerrainOp({
  type: 'flatten', kind: 'height', defaultBlend: 'set', shapes: ['circle', 'polygon', 'path'],
  validate(c, path, def, ctx) {
    checkParamNum(c, path, def, 'y', { min: 0, max: ctx.height })
  },
  compile(def) {
    const shape = compileShape(def.shape)
    const y = param(def, 'y', 0)
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
