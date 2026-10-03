import { blend } from '../shapes/blend.ts'
import { profile } from '../shapes/profile.ts'
import { compileShape, newSample } from '../shapes/shape.ts'
import { checkParamNoise, checkParamNum, checkParamProfile, noise2Of, param, paramStr, type Profile } from './common.ts'
import { defineTerrainOp } from './registry.ts'

/**
 * A peak (circle) or a range (path): value = height * profile(edge) * (1 - roughness + roughness * noise).
 * The default noise is ridged, which gives sharp crests. Default blend 'add'.
 */
export const mountain = defineTerrainOp({
  type: 'mountain', kind: 'height', defaultBlend: 'add', shapes: ['circle', 'path'],
  validate(c, path, def) {
    checkParamNum(c, path, def, 'height', { min: 0 })
    checkParamNum(c, path, def, 'roughness', { min: 0, max: 1, optional: true })
    checkParamProfile(c, path, def)
    checkParamNoise(c, path, def)
  },
  compile(def, ctx) {
    const shape = compileShape(def.shape)
    const height = param(def, 'height', 0), roughness = param(def, 'roughness', 0.5)
    const prof = paramStr<Profile>(def, 'profile', 'smooth')
    const noise = noise2Of(def, 'noise', { type: 'ridged', scale: 96, octaves: 5 }, ctx.seed)
    const mode = def.blend ?? 'add'
    const s = newSample()
    return {
      id: def.id,
      bounds: shape.bounds,
      apply(x, z, cell) {
        shape.sample(x, z, s)
        if (s.edge >= 1) return
        const v = height * profile(prof, s.edge) * (1 - roughness + roughness * noise(x, z))
        cell.h = blend(mode, cell.h, v, 1)
      },
    }
  },
})
