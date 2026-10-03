import { expandRect } from '../geom.ts'
import { blend } from '../shapes/blend.ts'
import { smoothstep01 } from '../shapes/profile.ts'
import { compileShape, newSample } from '../shapes/shape.ts'
import { checkParamNum, param } from './common.ts'
import { defineTerrainOp } from './registry.ts'

/**
 * A lake: a basin under water `level`. The floor drops half a block per block inward, down to
 * `depth` below the water; the shore rises at `shoreSlope` per block outside the shape and fades back
 * into the ground over the outer half of `shore`. Default blend 'min'.
 */
export const lake = defineTerrainOp({
  type: 'lake', kind: 'height', defaultBlend: 'min', shapes: ['circle', 'polygon'],
  validate(c, path, def, ctx) {
    checkParamNum(c, path, def, 'level', { min: 1, max: ctx.height - 1 })
    checkParamNum(c, path, def, 'depth', { min: 1, optional: true })
    checkParamNum(c, path, def, 'shore', { min: 0, optional: true })
    checkParamNum(c, path, def, 'shoreSlope', { gt: 0, optional: true })
  },
  compile(def) {
    const shape = compileShape(def.shape)
    const level = Math.floor(param(def, 'level', 1))
    const depth = param(def, 'depth', 6), shore = param(def, 'shore', 16), slope = param(def, 'shoreSlope', 0.4)
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
