import { blend } from '../shapes/blend.ts'
import { profile } from '../shapes/profile.ts'
import { compileShape, newSample } from '../shapes/shape.ts'
import { checkParamNoise, checkParamNum, checkParamProfile, noise2Of, param, paramStr, type Profile } from './common.ts'
import { defineTerrainOp } from './registry.ts'

/**
 * Cuts a valley (profile 'round' = U, 'linear' = V) or a canyon (profile 'box') along a path or in
 * an area: value = profile(edge) * (depth + noiseAmount * (2 * noise - 1)). Default blend 'carve'.
 */
export const valley = defineTerrainOp({
  type: 'valley', kind: 'height', defaultBlend: 'carve', shapes: ['path', 'circle', 'polygon'],
  validate(c, path, def) {
    checkParamNum(c, path, def, 'depth', { min: 0 })
    checkParamNum(c, path, def, 'noiseAmount', { min: 0, optional: true })
    checkParamProfile(c, path, def)
    checkParamNoise(c, path, def)
  },
  compile(def, ctx) {
    const shape = compileShape(def.shape)
    const depth = param(def, 'depth', 0), amount = param(def, 'noiseAmount', 0)
    const prof = paramStr<Profile>(def, 'profile', 'round')
    const noise = noise2Of(def, 'noise', { scale: 32, octaves: 3 }, ctx.seed)
    const mode = def.blend ?? 'carve'
    const s = newSample()
    return {
      id: def.id,
      bounds: shape.bounds,
      apply(x, z, cell) {
        shape.sample(x, z, s)
        if (s.edge >= 1) return
        const v = profile(prof, s.edge) * (depth + (amount > 0 ? amount * (noise(x, z) * 2 - 1) : 0))
        cell.h = blend(mode, cell.h, v, 1)
      },
    }
  },
})
