import { AXES } from '../mesh/greedy.ts'

/** Seconds a liquid vertex takes to glide from its displayed height to a remesh's new height. */
export const BLEND_SECONDS = 0.1
/** Drop (sixteenths of a block below the cell top) a newly appearing top-row vertex starts from: the cell bottom. */
export const NEW_DROP = 16

/** One applied liquid mesh: its packed vertices and, per vertex, the drop it glides from and when it started. */
export interface LiquidBlendState {
  vertices: Uint32Array
  prevDrop: Float32Array
  t0: Float32Array
}

/** The drop displayed at `now` by a vertex gliding from `prevDrop` to `drop` since `t0` (the shader's formula). */
export function blendedDrop(prevDrop: number, drop: number, t0: number, now: number): number {
  const k = Math.min(Math.max((now - t0) / BLEND_SECONDS, 0), 1)
  return prevDrop + (drop - prevDrop) * k
}

/** Per face × corner: 1 when the corner sits on the cell's top plane (mirrors the liquid mesher's vertex layout). */
const TOP_ROW = new Uint8Array(24)
for (let f = 0; f < 6; f++) {
  const [d, u, v] = AXES[f]!
  for (let c = 0; c < 4; c++) {
    const yOff = d === 1 ? ((f & 1) === 0 ? 1 : 0) : u === 1 ? (c === 1 || c === 2 ? 1 : 0) : v === 1 ? (c >= 2 ? 1 : 0) : 0
    TOP_ROW[f * 4 + c] = yOff
  }
}

/** Whether a liquid vertex (word A) is on its cell's top row, the only row whose height moves. */
export function isTopRow(a: number): boolean {
  return TOP_ROW[((a >>> 18) & 7) * 4 + ((a >>> 23) & 3)] === 1
}

const POS_MASK = 0x3ffff // x, y, z: word A bits 0-17
const shown = new Map<number, number>()

/**
 * Per-vertex blend start for a newly applied liquid mesh. A top-row vertex glides from the height `prev` displays at
 * its position now (first prev vertex there wins), or rises from the cell bottom (NEW_DROP) where prev had none.
 * Bottom-row vertices do not move.
 */
export function blendFrom(prev: LiquidBlendState | null, vertices: Uint32Array, now: number): { prevDrop: Float32Array; t0: Float32Array } {
  shown.clear()
  if (prev) {
    const pv = prev.vertices
    for (let i = 0; i < pv.length / 2; i++) {
      const a = pv[i * 2]!
      if (!isTopRow(a)) continue
      const key = a & POS_MASK
      if (!shown.has(key)) shown.set(key, blendedDrop(prev.prevDrop[i]!, (a >>> 25) & 31, prev.t0[i]!, now))
    }
  }
  const n = vertices.length / 2
  const prevDrop = new Float32Array(n)
  const t0 = new Float32Array(n).fill(now)
  for (let i = 0; i < n; i++) {
    const a = vertices[i * 2]!
    prevDrop[i] = isTopRow(a) ? (shown.get(a & POS_MASK) ?? NEW_DROP) : (a >>> 25) & 31
  }
  shown.clear()
  return { prevDrop, t0 }
}
