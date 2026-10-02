import { defineRules } from '@elovox/engine/sim-worker'

const AIR = 0

export default defineRules({
  blocks: {
    sand: {
      onNeighborChanged(ctx, x, y, z) { ctx.schedule(x, y, z, 2) },
      onScheduledTick(ctx, x, y, z, v) {
        if (y > 0 && ctx.isAir(ctx.get(x, y - 1, z))) { ctx.set(x, y, z, AIR); ctx.set(x, y - 1, z, v) }
      },
    },
    grass: {
      // Spreads to neighbouring dirt one level below, level or above, if that dirt has air above it.
      onRandomTick(ctx, x, y, z) {
        const dx = ctx.random() < 0.5 ? -1 : 1
        const dz = ctx.random() < 0.5 ? -1 : 1
        const dirt = ctx.id('dirt')
        const grass = ctx.id('grass')
        for (const [nx, nz] of [[x + dx, z], [x, z + dz]] as const) {
          const ny = y + Math.floor(ctx.random() * 3) - 1
          if (ny < 0) continue
          if (ctx.get(nx, ny, nz) === dirt && ctx.isAir(ctx.get(nx, ny + 1, nz))) ctx.set(nx, ny, nz, grass)
        }
      },
    },
  },
})
