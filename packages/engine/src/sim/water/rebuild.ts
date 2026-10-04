import type { BlockRegistry } from '../../blocks/registry.ts'
import { decodeUniform } from '../../world/buffers.ts'
import type { ChunkStore } from '../../world/chunkStore.ts'
import type { WaterColumns } from './columns.ts'
import { KIND, OVERHANG, SUB, UNIT } from './constants.ts'
import { quantize, type WaterMirror } from './mirror.ts'

/** Per block id: KIND.AIR for air, KIND.WATER for the simulated liquid `water`, KIND.WALL for everything else (springs and other liquids too). */
export function waterKinds(reg: BlockRegistry, water: number): Uint8Array {
  const k = new Uint8Array(4096).fill(KIND.WALL)
  k[0] = KIND.AIR
  if (water > 0 && water < reg.count) k[water] = KIND.WATER
  return k
}

/** Called for every rebuilt column whose floor moved. */
export type FloorMoved = (x: number, z: number, from: number, to: number) => void

function cell(chunks: readonly (Uint16Array | number)[], local: number, y: number): number {
  const ch = chunks[y >> 5]!
  return typeof ch === 'number' ? ch : ch[local + ((y & 31) << 10)]!
}

/**
 * Rebuilds columns [x0, x1) × [z0, z1) from the voxels (spec §4; plan decision 4). Each column is read from the top. The
 * first block that is not air decides:
 * - water: the water down from it to the next wall is the column's water (a run over air is not a floating column: air
 *   cells under it are skipped, and water further down joins it), and that wall its floor;
 * - a wall run at most OVERHANG thick over air or water (a bridge, a canopy): skipped, the scan goes on below it;
 * - any other wall: the column is dry, its floor on that wall.
 * An all-air column is dry on the world floor (0). Water under a wall that decided is static. The rebuilt columns' fluxes,
 * and the fluxes into them, are zeroed. The mirror records what the voxels hold: a canonical run (full cells under at most
 * one partial top) needs no rewrite, anything else is forced up to the run's top. Reads chunk slots directly.
 */
export function rebuildColumns(store: ChunkStore, kind: Uint8Array, cols: WaterColumns, mirror: WaterMirror,
  x0: number, z0: number, x1: number, z1: number, moved?: FloorMoved): void {
  const L = store.layout, H = L.size[1], sx = cols.sx
  const chunks = new Array<Uint16Array | number>(L.cy)
  for (let cz = z0 >> 5; cz <= (z1 - 1) >> 5; cz++) for (let cx = x0 >> 5; cx <= (x1 - 1) >> 5; cx++) {
    for (let cy = 0; cy < L.cy; cy++) {
      const e = store.table[L.chunkIndex(cx, cy, cz)]!
      chunks[cy] = e < 0 ? decodeUniform(e) : store.views.voxels(e)
    }
    const xa = Math.max(x0, cx * 32), xb = Math.min(x1, cx * 32 + 32)
    const za = Math.max(z0, cz * 32), zb = Math.min(z1, cz * 32 + 32)
    for (let z = za; z < zb; z++) for (let x = xa; x < xb; x++) {
      const local = (x & 31) + ((z & 31) << 5), c = x + z * sx
      let y = H - 1, top = -1, floor = 0
      while (y >= 0) {
        const ch = chunks[y >> 5]!
        const v = typeof ch === 'number' ? ch : ch[local + ((y & 31) << 10)]!
        const k = kind[v & 0xfff]!
        if (k === KIND.AIR) { y = typeof ch === 'number' ? (y & ~31) - 1 : y - 1; continue }
        if (k === KIND.WATER) { top = y; break }
        let r = y - 1
        while (r >= 0 && y - r <= OVERHANG && kind[cell(chunks, local, r) & 0xfff] === KIND.WALL) r--
        if (r >= 0 && y - r <= OVERHANG) { y = r; continue } // a thin floating run: look below it
        floor = y + 1
        break
      }
      let depth = 0, canonical = true
      if (top >= 0) {
        for (y = top; y >= 0; y--) {
          const v = cell(chunks, local, y), k = kind[v & 0xfff]!
          if (k === KIND.WALL) break
          // Water over air (placed or generated hovering) is no floating column: it rests on the next wall below.
          if (k === KIND.AIR) { canonical = false; continue }
          const units = ((v >>> 12) & 7) + 1
          if (units !== 8 && y !== top) canonical = false
          depth += units * UNIT
        }
        floor = y + 1
      }
      const old = cols.floor[c]!
      cols.floor[c] = floor
      cols.depth[c] = depth
      cols.flux[2 * c] = 0
      cols.flux[2 * c + 1] = 0
      if (x > 0) cols.flux[2 * (c - 1)] = 0
      if (z > 0) cols.flux[2 * (c - sx) + 1] = 0
      mirror.lo[c] = floor
      mirror.q[c] = depth === 0 ? floor * 8 : canonical ? quantize(floor * SUB + depth) : ~((top + 1) * 8)
      if (old !== floor) moved?.(x, z, old, floor)
    }
  }
}
