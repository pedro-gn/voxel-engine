import { expandRect } from '../geom.ts'
import { blend } from '../shapes/blend.ts'
import { compileShape, newSample, weight } from '../shapes/shape.ts'
import { checkParamNoise, checkParamNum, noise2Of, param } from './common.ts'
import { defineTerrainOp } from './registry.ts'

/**
 * Procedural fill inside an area: value = offset + amplitude * noise (noise in [0, 1]).
 * Default blend 'add' (bumps on top of the ground); with 'min' and a low offset it lowers an area
 * into a sea floor; with 'set' it replaces the ground.
 */
export const hills = defineTerrainOp({
  type: 'hills', kind: 'height', defaultBlend: 'add', shapes: ['circle', 'polygon', 'path'],
  validate(c, path, def) {
    checkParamNum(c, path, def, 'amplitude', { min: 0 })
    checkParamNum(c, path, def, 'offset', { optional: true })
    checkParamNoise(c, path, def)
  },
  compile(def, ctx) {
    const shape = compileShape(def.shape)
    const amplitude = param(def, 'amplitude', 0), offset = param(def, 'offset', 0)
    const noise = noise2Of(def, 'noise', { scale: 64 }, ctx.seed)
    const mode = def.blend ?? 'add'
    const s = newSample()
    return {
      id: def.id,
      bounds: expandRect(shape.bounds, shape.falloff),
      apply(x, z, cell) {
        shape.sample(x, z, s)
        const w = weight(s, shape.falloff)
        if (w > 0) cell.h = blend(mode, cell.h, offset + amplitude * noise(x, z), w)
      },
    }
  },
})
