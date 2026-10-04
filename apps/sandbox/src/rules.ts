import { defineRules, type RuleContext } from '@elovox/engine/sim-worker'

/** Grass youth lives in state bits 0–1: 0 is mature; grass that just spread starts at YOUNG. */
const YOUNG = 3
/** Light a grass cell needs above it to spread there. */
const MIN_SKY = 9
const SIDES: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1]]
/** Every offset within Manhattan distance 2. */
const NEAR: readonly (readonly [number, number, number])[] = (() => {
  const out: [number, number, number][] = []
  for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    const d = Math.abs(dx) + Math.abs(dy) + Math.abs(dz)
    if (d >= 1 && d <= 2) out.push([dx, dy, dz])
  }
  return out
})()

/** True if water (or a spring) is within Manhattan distance 2. */
export function nearWater(ctx: RuleContext, x: number, y: number, z: number): boolean {
  for (const [dx, dy, dz] of NEAR) if (ctx.isLiquid(ctx.get(x + dx, y + dy, z + dz))) return true
  return false
}

/** One block turns into another when water is near (or gone). */
function wetting(wet: string, dry: string) {
  return {
    [dry]: { onRandomTick(ctx: RuleContext, x: number, y: number, z: number) { if (nearWater(ctx, x, y, z)) ctx.set(x, y, z, ctx.id(wet)) } },
    [wet]: { onRandomTick(ctx: RuleContext, x: number, y: number, z: number) { if (!nearWater(ctx, x, y, z)) ctx.set(x, y, z, ctx.id(dry)) } },
  }
}

export default defineRules({
  blocks: {
    grass: {
      // Dies under an opaque block or water; otherwise matures one step and tries to spread to lit dirt nearby.
      onRandomTick(ctx, x, y, z, v) {
        const above = ctx.get(x, y + 1, z)
        if (ctx.isOpaque(above) || ctx.isLiquid(above)) { ctx.set(x, y, z, ctx.id('dirt')); return }
        const youth = ctx.state(v) & 3
        if (youth > 0) ctx.set(x, y, z, ctx.withState(v, youth - 1))
        const [dx, dz] = SIDES[Math.floor(ctx.random() * 4)]!
        const nx = x + dx, nz = z + dz, ny = y + Math.floor(ctx.random() * 3) - 1
        if (ny < 0 || ctx.get(nx, ny, nz) !== ctx.id('dirt')) return
        const top = ctx.get(nx, ny + 1, nz)
        if (ctx.isOpaque(top) || ctx.isLiquid(top) || ctx.skyLight(nx, ny + 1, nz) < MIN_SKY) return
        ctx.set(nx, ny, nz, ctx.withState(ctx.id('grass'), YOUNG))
      },
    },
    ...wetting('mud', 'dirt'),
    ...wetting('wet_sand', 'sand'),
  },
})
