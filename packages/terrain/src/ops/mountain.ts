import { makeNoise2 } from '../noise/def.ts'
import { blend } from '../shapes/blend.ts'
import { PROFILES, profile } from '../shapes/profile.ts'
import { compileShape, newSample } from '../shapes/shape.ts'
import { defineTerrainOp } from './registry.ts'
import { paramsOf, type ParamSchema } from './schema.ts'

const PARAMS = {
  height: { type: 'number', required: true, default: 40, min: 0, range: [0, 100] },
  roughness: { type: 'number', default: 0.5, min: 0, max: 1, step: 0.05 },
  profile: { type: 'enum', values: PROFILES, default: 'smooth' },
  noise: { type: 'noise', default: { type: 'ridged', scale: 96, octaves: 5 } },
} as const satisfies ParamSchema

/**
 * A peak (circle) or a range (path): value = height * profile(edge) * (1 - roughness + roughness * noise).
 * The default noise is ridged, which gives sharp crests. Default blend 'add'.
 */
export const mountain = defineTerrainOp({
  type: 'mountain', kind: 'height', defaultBlend: 'add', shapes: ['circle', 'path'], falloff: false, params: PARAMS,
  compile(def, ctx) {
    const shape = compileShape(def.shape)
    const p = paramsOf(def, PARAMS)
    const noise = makeNoise2(p.noise, ctx.seed)
    const mode = def.blend ?? 'add'
    const s = newSample()
    return {
      id: def.id,
      bounds: shape.bounds,
      apply(x, z, cell) {
        shape.sample(x, z, s)
        if (s.edge >= 1) return
        const v = p.height * profile(p.profile, s.edge) * (1 - p.roughness + p.roughness * noise(x, z))
        cell.h = blend(mode, cell.h, v, 1)
      },
    }
  },
})
