import { clamp, expandRect } from '../geom.ts'
import { makeNoise2 } from '../noise/def.ts'
import { blend } from '../shapes/blend.ts'
import { smoothstep01 } from '../shapes/profile.ts'
import { compileShape, newSample } from '../shapes/shape.ts'
import { defineTerrainOp } from './registry.ts'
import { WORLD_TOP, paramsOf, type ParamSchema } from './schema.ts'

/** 0 → 1 rise; with k terraces, flat treads joined by steep smooth risers. */
export function terrace(t: number, k: number): number {
  if (k <= 0) return smoothstep01(t)
  const x = t * k
  const i = Math.floor(x)
  return Math.min(1, (i + smoothstep01((x - i - 0.65) / 0.35)) / k)
}

const PARAMS = {
  top: { type: 'number', required: true, default: 24, min: 0, max: WORLD_TOP, anchor: 'ground' },
  base: { type: 'number', required: true, default: 0, min: 0, max: WORLD_TOP, anchor: 'ground' },
  wall: { type: 'number', default: 6, gt: 0, range: [1, 32] },
  terraces: { type: 'number', default: 0, int: true, min: 0, max: 16 },
  jitter: { type: 'number', default: 0, min: 0, range: [0, 16] },
  noise: { type: 'noise', default: { scale: 24, octaves: 3 } },
} as const satisfies ParamSchema

/**
 * A mesa: rises from `base` at the shape's edge to `top` over `wall` blocks inward, optionally in
 * `terraces` steps. `jitter` (blocks) roughens the wall line with noise. Default blend 'max', so the
 * wall's foot merges with higher ground.
 */
export const plateau = defineTerrainOp({
  type: 'plateau', kind: 'height', defaultBlend: 'max', shapes: ['circle', 'polygon'], falloff: false, params: PARAMS,
  compile(def, ctx) {
    const shape = compileShape(def.shape)
    const p = paramsOf(def, PARAMS)
    const noise = makeNoise2(p.noise, ctx.seed)
    const mode = def.blend ?? 'max'
    const s = newSample()
    return {
      id: def.id,
      bounds: expandRect(shape.bounds, p.jitter),
      apply(x, z, cell) {
        shape.sample(x, z, s)
        const inward = -s.dist + (p.jitter > 0 ? p.jitter * (noise(x, z) * 2 - 1) : 0)
        if (inward <= 0) return
        const v = p.base + (p.top - p.base) * terrace(clamp(inward / p.wall, 0, 1), p.terraces)
        cell.h = blend(mode, cell.h, v, 1)
      },
    }
  },
})
