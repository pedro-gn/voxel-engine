import type { BlendMode } from '../doc/types.ts'

/**
 * Combines the height so far `h` with an op's value `v` under mask weight `w` in [0, 1].
 * add/carve: v is relative (blocks up/down). max/min/set: v is an absolute y.
 */
export function blend(mode: BlendMode, h: number, v: number, w: number): number {
  switch (mode) {
    case 'add': return h + v * w
    case 'carve': return h - v * w
    case 'max': return v > h ? h + (v - h) * w : h
    case 'min': return v < h ? h + (v - h) * w : h
    case 'set': return h + (v - h) * w
  }
}
