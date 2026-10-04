import type { WaterBuffers } from '../../world/waterBuffers.ts'
import { moved, type WaterColumns } from './columns.ts'
import { SUB, TILE } from './constants.ts'

/** One publish (plan design notes: Publishing): its sequence number, the parity buffer it wrote, and the tiles in it. */
export interface WaterTick { seq: number; parity: number; tiles: number[] }

function clamp16(v: number): number { return v > 32767 ? 32767 : v < -32768 ? -32768 : v }

/** The sorted union of two sorted tile lists. */
export function mergeTiles(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = []
  let i = 0, j = 0
  while (i < a.length || j < b.length) {
    const v = j >= b.length || (i < a.length && a[i]! < b[j]!) ? a[i++]! : b[j++]!
    if (out.length === 0 || out[out.length - 1] !== v) out.push(v)
  }
  return out
}

/**
 * Writes the heightfield into the shared double buffer. Publish n writes into parity n & 1 the tiles that changed since the
 * last publish plus that publish's tiles, so each parity buffer is complete as of its last publish. The stamp brackets the
 * write (−1 while writing), so a reader can tell a buffer that was reused under it.
 */
export class WaterPublisher {
  private readonly surface: Int32Array
  private readonly flux: Int16Array
  private readonly stamp: Int32Array
  private seq = 0
  private last: number[] = []

  constructor(b: WaterBuffers) {
    this.surface = new Int32Array(b.surface)
    this.flux = new Int16Array(b.flux)
    this.stamp = new Int32Array(b.stamp)
  }

  /** Publishes `changed` (sorted tile indices) plus the previous publish's tiles; null when both are empty. */
  publish(changed: readonly number[], cols: WaterColumns): WaterTick | null {
    const tiles = mergeTiles(changed, this.last)
    this.last = [...changed]
    if (tiles.length === 0) return null
    const seq = ++this.seq, p = seq & 1, base = p * cols.n, T = cols.tiles, sx = cols.sx
    Atomics.store(this.stamp, p, -1)
    for (const t of tiles) {
      const x0 = (t % T.tx) * TILE, z0 = Math.floor(t / T.tx) * TILE
      for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) {
        const c = x + z * sx, d = cols.depth[c]!, s = cols.floor[c]! * SUB + d
        this.surface[base + c] = d > 0 ? s : ~s
        this.flux[2 * (base + c)] = clamp16(moved(cols.flux[2 * c]!))
        this.flux[2 * (base + c) + 1] = clamp16(moved(cols.flux[2 * c + 1]!))
      }
    }
    Atomics.store(this.stamp, p, seq)
    return { seq, parity: p, tiles }
  }
}
