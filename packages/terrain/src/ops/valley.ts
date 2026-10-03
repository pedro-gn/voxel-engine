import { makeNoise2 } from '../noise/def.ts'
import { blend } from '../shapes/blend.ts'
import { PROFILES, profile } from '../shapes/profile.ts'
import { compileShape, newSample } from '../shapes/shape.ts'
import { defineTerrainOp } from './registry.ts'
import { paramsOf, type ParamSchema } from './schema.ts'

const PARAMS = {
  depth: { type: 'number', required: true, default: 12, min: 0, range: [0, 64] },
  noiseAmount: { type: 'number', default: 0, min: 0, range: [0, 16] },
  profile: { type: 'enum', values: PROFILES, default: 'round' },
  noise: { type: 'noise', default: { scale: 32, octaves: 3 } },
} as const satisfies ParamSchema

/**
 * Cuts a valley (profile 'round' = U, 'linear' = V) or a canyon (profile 'box') along a path or in
 * an area: value = profile(edge) * (depth + noiseAmount * (2 * noise - 1)). Default blend 'carve'.
 */
export const valley = defineTerrainOp({
  type: 'valley', kind: 'height', defaultBlend: 'carve', shapes: ['path', 'circle', 'polygon'], falloff: false, params: PARAMS,
  compile(def, ctx) {
    const shape = compileShape(def.shape)
    const p = paramsOf(def, PARAMS)
    const noise = makeNoise2(p.noise, ctx.seed)
    const mode = def.blend ?? 'carve'
    const s = newSample()
    return {
      id: def.id,
      bounds: shape.bounds,
      apply(x, z, cell) {
        shape.sample(x, z, s)
        if (s.edge >= 1) return
        const v = profile(p.profile, s.edge) * (p.depth + (p.noiseAmount > 0 ? p.noiseAmount * (noise(x, z) * 2 - 1) : 0))
        cell.h = blend(mode, cell.h, v, 1)
      },
    }
  },
})
