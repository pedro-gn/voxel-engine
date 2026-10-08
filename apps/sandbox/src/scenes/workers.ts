import { defineGenerator } from '@elovox/engine/sim-worker'
import type { WorkerOptions } from '@elovox/engine'

export const WORKERS_SIZE = [128, 64, 128] as const
export const WORKER_OPTIONS: WorkerOptions = {
  maxUnits: 1000, searchCap: 8192,
  materials: {
    stone: { digTicks: 20, buildTicks: 10, tool: 'pick' },
    dirt: { digTicks: 8, buildTicks: 6 }, grass: { digTicks: 8, buildTicks: 6, drop: 'dirt' },
    planks: { digTicks: 10, buildTicks: 10 }, glass: { digTicks: 8, buildTicks: 8 },
    structural_planks: { digTicks: 10, buildTicks: 10 },
  },
}
export const workersGenerator = defineGenerator({
  generateColumn(ctx, cx, cz) {
    const stone = ctx.id('stone'), grass = ctx.id('grass'), dirt = ctx.id('dirt'), planks = ctx.id('planks'), water = ctx.id('water')
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
      const wx = cx * 32 + x, wz = cz * 32 + z
      // Ground and a shallow trench crossed by a five-block bridge blueprint.
      const trench = wx >= 42 && wx <= 46 && wz >= 22 && wz <= 40
      for (let y = 0; y < (trench ? 2 : 5); y++) ctx.set(x, y, z, y === 4 ? grass : dirt)
      // Diggable rock wall: the tunnel demonstration opens the lower two cells.
      if (wx >= 22 && wx <= 26 && wz >= 20 && wz <= 38) for (let y = 5; y < 10; y++) ctx.set(x, y, z, stone)
      // A roof with an accessible cave underneath; both floors are navigable.
      if (wx >= 62 && wx <= 82 && wz >= 20 && wz <= 38) ctx.set(x, 9, z, stone)
      if ((wx === 62 || wx === 82) && (wz === 20 || wz === 38)) for (let y = 5; y < 9; y++) ctx.set(x, y, z, stone)
      // Walkable steps toward the roof, outside the cave opening.
      if (wz >= 39 && wz <= 41 && wx >= 62 && wx <= 66) for (let y = 5; y < 5 + wx - 61; y++) ctx.set(x, y, z, planks)
      // A small pool, kept away from the initial work sites.
      if (wx >= 18 && wx <= 28 && wz >= 53 && wz <= 63) for (let y = 5; y < 7; y++) ctx.set(x, y, z, water | (7 << 12))
      if ((wx === 17 || wx === 29) && wz >= 52 && wz <= 64 || (wz === 52 || wz === 64) && wx >= 17 && wx <= 29) for (let y = 5; y < 8; y++) ctx.set(x, y, z, stone)
      // A terrace backdrop; gives the scene depth without covering the work field.
      if (wz >= 78) for (let y = 5; y < 5 + Math.min(10, Math.floor((wz - 76) / 4)); y++) ctx.set(x, y, z, y === 5 ? grass : dirt)
    }
  },
})
