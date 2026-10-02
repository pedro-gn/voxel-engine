import { defineGenerator } from './generator.ts'

/** Layered heightmap: stone, 2 blocks of dirt, a grass top. Needs blocks "stone", "dirt", "grass". */
export const testGenerator = defineGenerator({
  generateColumn(ctx, cx, cz) {
    const stone = ctx.id('stone'), dirt = ctx.id('dirt'), grass = ctx.id('grass')
    const base = Math.floor(ctx.height * 0.35)
    const amp = Math.floor(ctx.height * 0.25)
    for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
      const x = cx * 32 + lx, z = cz * 32 + lz
      const h = Math.max(4, Math.min(ctx.height - 2, base + Math.floor(ctx.fbm2(x / 48, z / 48, 4) * amp)))
      for (let y = 0; y < h; y++) ctx.set(lx, y, lz, y === h - 1 ? grass : y >= h - 3 ? dirt : stone)
    }
  },
})
