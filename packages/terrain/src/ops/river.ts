import { expandRect } from '../geom.ts'
import { blend } from '../shapes/blend.ts'
import { smoothstep01 } from '../shapes/profile.ts'
import { compileShape, newSample } from '../shapes/shape.ts'
import { defineTerrainOp } from './registry.ts'
import { BELOW_TOP, paramsOf, type ParamSchema } from './schema.ts'

const PARAMS = {
  start: { type: 'number', required: true, default: 0, min: 1, max: BELOW_TOP, anchor: 'ground' },
  end: { type: 'number', required: true, default: -6, min: 1, max: BELOW_TOP, anchor: 'ground' },
  depth: { type: 'number', default: 3, min: 0, range: [0, 12] },
  bank: { type: 'number', default: 16, min: 0, range: [0, 64] },
  bankSlope: { type: 'number', default: 0.5, gt: 0, step: 0.05, range: [0.05, 2] },
  flow: { type: 'number', default: 8, min: 0, max: 15, int: true, range: [0, 15] },
} as const satisfies ParamSchema

/**
 * A river along a path. The water level goes from `start` (first point) to `end` (last point) in
 * whole-block steps. Inside the path's width the bed is a U `depth` blocks below the water; outside,
 * banks climb at `bankSlope` per block and fade back into the ground over the outer half of `bank`,
 * so the river cuts a valley through high ground without leaving a step. Default blend 'min'.
 * A spring with flow index `flow` (0 = none) sits in the bed under the first point; the sim's water then runs from it.
 */
export const river = defineTerrainOp({
  type: 'river', kind: 'height', defaultBlend: 'min', shapes: ['path'], falloff: false, params: PARAMS,
  compile(def) {
    const shape = compileShape(def.shape)
    const { start, end, depth, bank, bankSlope: slope, flow } = paramsOf(def, PARAMS)
    const head = def.shape.kind === 'path' ? def.shape.points[0] : undefined
    const spring = flow > 0 && head ? { x: Math.floor(head.x), z: Math.floor(head.z), flow } : undefined
    const mode = def.blend ?? 'min'
    const s = newSample()
    return {
      id: def.id,
      bounds: expandRect(shape.bounds, bank),
      spring,
      apply(x, z, cell) {
        shape.sample(x, z, s)
        const hw = s.width / 2
        const d = s.edge * hw // distance to the axis
        if (d > hw + bank) return
        const level = Math.floor(start + (end - start) * s.along)
        const target = d <= hw
          ? level - 1 - depth * Math.sqrt(1 - (d / hw) * (d / hw))
          : level + (d - hw) * slope
        const out = d - hw
        const fade = out <= bank * 0.5 ? 1 : smoothstep01((bank - out) / (bank * 0.5))
        cell.h = blend(mode, cell.h, target, fade)
        if (d <= hw && level > cell.water) cell.water = level
        if (level > cell.wet) cell.wet = level
      },
    }
  },
})
