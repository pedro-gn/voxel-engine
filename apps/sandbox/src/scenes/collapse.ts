import type { Command } from '@elovox/engine'
import { defineGenerator } from '@elovox/engine/sim-worker'
import { AIR } from '@elovox/engine/src/world/voxel.ts'

export const COLLAPSE_SIZE = [128, 64, 128] as const
let stress = false
export const collapseGenerator = defineGenerator({
  configure(doc) { stress = typeof doc === 'object' && doc !== null && (doc as { stress?: boolean }).stress === true },
  generateColumn(ctx, cx, cz) {
    const stone = ctx.id('stone'), grass = ctx.id('grass'), beam = ctx.id('structural_planks'), glass = ctx.id('structural_glass')
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
      const wx = cx * 32 + x, wz = cz * 32 + z
      for (let y = 0; y < 4; y++) ctx.set(x, y, z, y === 3 ? grass : stone)
      // Two independent supports and a deck crossing the x=32 chunk seam.
      if ((wx === 24 || wx === 40) && wz >= 28 && wz <= 31) for (let y = 4; y < 20; y++) ctx.set(x, y, z, stone)
      if (wx >= 24 && wx <= 40 && wz >= 28 && wz <= 31) ctx.set(x, 20, z, beam)
      // A tower resting on a removable normal plinth.
      if (wx >= 72 && wx <= 79 && wz >= 28 && wz <= 35) {
        for (let y = 4; y <= 12; y++) ctx.set(x, y, z, stone)
        for (let y = 13; y <= 39; y++) {
          if (wx === 72 || wx === 79 || wz === 28 || wz === 35) ctx.set(x, y, z, y >= 28 && y <= 31 ? glass : beam)
        }
      }
      // This normal floating beam stays where it is even after support removal.
      if (wx >= 24 && wx <= 40 && wz >= 65 && wz <= 68) ctx.set(x, 20, z, stone)
      if (wx === 24 && wz >= 65 && wz <= 68) for (let y = 4; y < 20; y++) ctx.set(x, y, z, stone)
      if (stress && wx >= 16 && wx < 112 && wz >= 16 && wz < 112) ctx.set(x, 50, z, beam)
      if (stress && wx === 15 && wz === 16) ctx.set(x, 50, z, stone)
    }
  },
})

const cut = (min: [number, number, number], max: [number, number, number]): Command => ({ type: 'fillRegion', min, max, voxel: AIR })
export const cutLeftCommands = (): Command[] => [cut([24, 4, 28], [24, 19, 31])]
export const cutRightCommands = (): Command[] => [cut([40, 4, 28], [40, 19, 31])]
export const cutTowerCommands = (): Command[] => [cut([72, 4, 28], [79, 12, 35])]
export const cutNormalCommands = (): Command[] => [cut([24, 4, 65], [24, 19, 68])]
export const stressCollapseCommands = (): Command[] => [cut([15, 50, 16], [15, 50, 16])]
