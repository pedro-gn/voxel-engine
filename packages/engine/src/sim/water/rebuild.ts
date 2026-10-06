import type { BlockRegistry } from '../../blocks/registry.ts'
import { decodeUniform } from '../../world/buffers.ts'
import type { ChunkStore } from '../../world/chunkStore.ts'
import type { WaterColumns } from './columns.ts'
import { KIND, OVERHANG, SUB, UNIT } from './constants.ts'
import { quantize, type WaterMirror } from './mirror.ts'
import type { UnderSegments } from './under.ts'

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

/**
 * Rebuilds columns [x0, x1) × [z0, z1) as segments (3d spec §5 Rebuild; plan decision 11). Each column is read bottom-up
 * and every run of non-wall cells becomes a segment: its water is all the water in the run, resting on its floor. The top
 * run (it reaches the world's height; empty at the height when the top cell is a wall) is the column (floor, depth, the
 * mirror state, fluxes zeroed as in rebuildColumns); the others replace the column's lower chain. A run's mirror is
 * canonical when its water lies full from the floor up with at most a partial top, else forced up to its highest water
 * cell. Uniform air and wall chunks are skipped whole. The caller rebuilds the edges and bodies of the region.
 */
export function rebuildSegments(store: ChunkStore, kind: Uint8Array, cols: WaterColumns, under: UnderSegments, mirror: WaterMirror,
  x0: number, z0: number, x1: number, z1: number): void {
  const L = store.layout, H = L.size[1], sx = cols.sx
  const chunks = new Array<Uint16Array | number>(L.cy)
  const runs = new Int32Array((H + 1) * 4) // per run: floor, ceil, depth, mirror q
  const list: number[] = []
  for (let cz = z0 >> 5; cz <= (z1 - 1) >> 5; cz++) for (let cx = x0 >> 5; cx <= (x1 - 1) >> 5; cx++) {
    for (let cy = 0; cy < L.cy; cy++) {
      const e = store.table[L.chunkIndex(cx, cy, cz)]!
      chunks[cy] = e < 0 ? decodeUniform(e) : store.views.voxels(e)
    }
    const xa = Math.max(x0, cx * 32), xb = Math.min(x1, cx * 32 + 32)
    const za = Math.max(z0, cz * 32), zb = Math.min(z1, cz * 32 + 32)
    for (let z = za; z < zb; z++) for (let x = xa; x < xb; x++) {
      const local = (x & 31) + ((z & 31) << 5), c = x + z * sx
      let k = 0, f = -1, depth = 0, wTop = -1, canonical = true, gap = false, lastUnits = 8
      const open = (y: number) => { f = y; depth = 0; wTop = -1; canonical = true; gap = false; lastUnits = 8 }
      const close = (ceil: number) => {
        const o = k * 4
        runs[o] = f; runs[o + 1] = ceil; runs[o + 2] = depth
        runs[o + 3] = depth === 0 ? f * 8 : canonical ? quantize(f * SUB + depth) : ~((wTop + 1) * 8)
        k++
        f = -1
      }
      let y = 0
      while (y < H) {
        const ch = chunks[y >> 5]!
        if (typeof ch === 'number') {
          const kk = kind[ch & 0xfff]!
          if (kk === KIND.WALL) { if (f >= 0) close(y); y = (y | 31) + 1; continue }
          if (kk === KIND.AIR) { if (f < 0) open(y); gap = true; y = (y | 31) + 1; continue }
        }
        const v = typeof ch === 'number' ? ch : ch[local + ((y & 31) << 10)]!
        const kk = kind[v & 0xfff]!
        if (kk === KIND.WALL) { if (f >= 0) close(y); y++; continue }
        if (f < 0) open(y)
        if (kk === KIND.WATER) {
          const units = ((v >>> 12) & 7) + 1
          if (gap || lastUnits !== 8) canonical = false
          depth += units * UNIT
          wTop = y
          lastUnits = units
        } else gap = true
        y++
      }
      if (f >= 0) close(H)
      else { runs[k * 4] = H; runs[k * 4 + 1] = H; runs[k * 4 + 2] = 0; runs[k * 4 + 3] = H * 8; k++ }
      const t = (k - 1) * 4
      cols.floor[c] = runs[t]!
      cols.depth[c] = runs[t + 2]!
      cols.flux[2 * c] = 0
      cols.flux[2 * c + 1] = 0
      if (x > 0) cols.flux[2 * (c - 1)] = 0
      if (z > 0) cols.flux[2 * (c - sx) + 1] = 0
      mirror.lo[c] = runs[t]!
      mirror.q[c] = runs[t + 3]!
      under.freeColumn(c)
      list.length = 0
      for (let r = 0; r < k - 1; r++) {
        const o = r * 4, i = under.alloc(c, runs[o]!, runs[o + 1]!, runs[o + 2]!)
        under.mirrorLo[i] = runs[o]!
        under.mirrorQ[i] = runs[o + 3]!
        list.push(i)
      }
      under.setChain(c, list)
    }
  }
}
