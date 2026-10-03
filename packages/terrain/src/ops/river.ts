import { expandRect } from '../geom.ts'
import { blend } from '../shapes/blend.ts'
import { smoothstep01 } from '../shapes/profile.ts'
import { compileShape, newSample } from '../shapes/shape.ts'
import { checkParamNum, param } from './common.ts'
import { defineTerrainOp } from './registry.ts'

/**
 * A river along a path. The water level goes from `start` (first point) to `end` (last point) in
 * whole-block steps. Inside the path's width the bed is a U `depth` blocks below the water; outside,
 * banks climb at `bankSlope` per block and fade back into the ground over the outer half of `bank`,
 * so the river cuts a valley through high ground without leaving a step. Default blend 'min'.
 */
export const river = defineTerrainOp({
  type: 'river', kind: 'height', defaultBlend: 'min', shapes: ['path'],
  validate(c, path, def, ctx) {
    checkParamNum(c, path, def, 'start', { min: 1, max: ctx.height - 1 })
    checkParamNum(c, path, def, 'end', { min: 1, max: ctx.height - 1 })
    checkParamNum(c, path, def, 'depth', { min: 0, optional: true })
    checkParamNum(c, path, def, 'bank', { min: 0, optional: true })
    checkParamNum(c, path, def, 'bankSlope', { gt: 0, optional: true })
  },
  compile(def) {
    const shape = compileShape(def.shape)
    const start = param(def, 'start', 1), end = param(def, 'end', 1)
    const depth = param(def, 'depth', 3), bank = param(def, 'bank', 16), slope = param(def, 'bankSlope', 0.5)
    const mode = def.blend ?? 'min'
    const s = newSample()
    return {
      id: def.id,
      bounds: expandRect(shape.bounds, bank),
      apply(x, z, cell) {
        shape.sample(x, z, s)
        const hw = s.width / 2
        const d = s.edge * hw // distance to the axis
        if (d > hw + bank) return
        const level = Math.floor(start + (end - start) * s.along)
        const target = d <= hw
          ? level - 1 - depth * Math.sqrt(1 - (d / hw) * (d / hw))
          : level - 1 + (d - hw) * slope
        const out = d - hw
        const fade = out <= bank * 0.5 ? 1 : smoothstep01((bank - out) / (bank * 0.5))
        cell.h = blend(mode, cell.h, target, fade)
        if (d <= hw && level > cell.water) cell.water = level
        if (level > cell.wet) cell.wet = level
      },
    }
  },
})
