import { clamp, expandRect } from '../geom.ts'
import { blend } from '../shapes/blend.ts'
import { smoothstep01 } from '../shapes/profile.ts'
import { compileShape, newSample } from '../shapes/shape.ts'
import { checkParamNoise, checkParamNum, noise2Of, param } from './common.ts'
import { defineTerrainOp } from './registry.ts'

/** 0 → 1 rise; with k terraces, flat treads joined by steep smooth risers. */
export function terrace(t: number, k: number): number {
  if (k <= 0) return smoothstep01(t)
  const x = t * k
  const i = Math.floor(x)
  return Math.min(1, (i + smoothstep01((x - i - 0.65) / 0.35)) / k)
}

/**
 * A mesa: rises from `base` at the shape's edge to `top` over `wall` blocks inward, optionally in
 * `terraces` steps. `jitter` (blocks) roughens the wall line with noise. Default blend 'max', so the
 * wall's foot merges with higher ground.
 */
export const plateau = defineTerrainOp({
  type: 'plateau', kind: 'height', defaultBlend: 'max', shapes: ['circle', 'polygon'],
  validate(c, path, def, ctx) {
    checkParamNum(c, path, def, 'top', { min: 0, max: ctx.height })
    checkParamNum(c, path, def, 'base', { min: 0, max: ctx.height })
    checkParamNum(c, path, def, 'wall', { gt: 0, optional: true })
    checkParamNum(c, path, def, 'terraces', { int: true, min: 0, max: 16, optional: true })
    checkParamNum(c, path, def, 'jitter', { min: 0, optional: true })
    checkParamNoise(c, path, def)
  },
  compile(def, ctx) {
    const shape = compileShape(def.shape)
    const top = param(def, 'top', 0), base = param(def, 'base', 0)
    const wall = param(def, 'wall', 6), k = param(def, 'terraces', 0), jitter = param(def, 'jitter', 0)
    const noise = noise2Of(def, 'noise', { scale: 24, octaves: 3 }, ctx.seed)
    const mode = def.blend ?? 'max'
    const s = newSample()
    return {
      id: def.id,
      bounds: expandRect(shape.bounds, jitter),
      apply(x, z, cell) {
        shape.sample(x, z, s)
        const inward = -s.dist + (jitter > 0 ? jitter * (noise(x, z) * 2 - 1) : 0)
        if (inward <= 0) return
        const v = base + (top - base) * terrace(clamp(inward / wall, 0, 1), k)
        cell.h = blend(mode, cell.h, v, 1)
      },
    }
  },
})
