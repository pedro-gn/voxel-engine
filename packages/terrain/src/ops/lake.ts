import { expandRect } from '../geom.ts'
import { blend } from '../shapes/blend.ts'
import { smoothstep01 } from '../shapes/profile.ts'
import { compileShape, newSample } from '../shapes/shape.ts'
import { defineTerrainOp } from './registry.ts'
import { BELOW_TOP, paramsOf, type ParamSchema } from './schema.ts'

const PARAMS = {
  level: { type: 'number', required: true, default: 0, min: 1, max: BELOW_TOP, anchor: 'ground' },
  depth: { type: 'number', default: 6, min: 1, range: [1, 32] },
  shore: { type: 'number', default: 16, min: 0, range: [0, 64] },
  shoreSlope: { type: 'number', default: 0.4, gt: 0, step: 0.05, range: [0.05, 2] },
} as const satisfies ParamSchema

/**
 * A lake: a basin under water `level`. The floor drops half a block per block inward, down to
 * `depth` below the water; the shore rises at `shoreSlope` per block outside the shape and fades back
 * into the ground over the outer half of `shore`. Default blend 'min'.
 */
export const lake = defineTerrainOp({
  type: 'lake', kind: 'height', defaultBlend: 'min', shapes: ['circle', 'polygon'], falloff: false, params: PARAMS,
  compile(def) {
    const shape = compileShape(def.shape)
    const p = paramsOf(def, PARAMS)
    const level = Math.floor(p.level)
    const { depth, shore, shoreSlope: slope } = p
    const mode = def.blend ?? 'min'
    const s = newSample()
    return {
      id: def.id,
      bounds: expandRect(shape.bounds, shore),
      apply(x, z, cell) {
        shape.sample(x, z, s)
        if (s.dist > shore) return
        const target = s.dist <= 0
          ? level - 1 - Math.min(depth, 1 + -s.dist * 0.5)
          : level + s.dist * slope
        const fade = s.dist <= shore * 0.5 ? 1 : smoothstep01((shore - s.dist) / (shore * 0.5))
        cell.h = blend(mode, cell.h, target, fade)
        if (s.dist <= 0 && level > cell.water) cell.water = level
        if (level > cell.wet) cell.wet = level
      },
    }
  },
})
