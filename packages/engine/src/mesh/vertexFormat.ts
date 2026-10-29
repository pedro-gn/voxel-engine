export const FACE = { PX: 0, NX: 1, PY: 2, NY: 3, PZ: 4, NZ: 5 } as const
export const FACE_NORMALS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
]

/** Word A: x(6) y(6) z(6) normal(3) ao(2) corner(2) drop(5) cut(1) fringe(1). */
export function packA(x: number, y: number, z: number, normal: number, ao: number, corner: number, drop = 0): number {
  return (x | (y << 6) | (z << 12) | (normal << 18) | (ao << 21) | (corner << 23) | (drop << 25)) >>> 0
}
/**
 * Liquid vertices have no AO: their ao bits carry flags instead. LIQUID_DEEP marks a top-row vertex of a cell whose
 * cell below holds the same liquid (deep water: its surface counts as full height for foam).
 */
export const LIQUID_DEEP = 1

/** Word A bit 30: a top face created by the layer cut (spec §4), drawn a little darker. */
export const CUT_BIT = 1 << 30
/**
 * Word A bit 31: a fringe strip (BlockDef.fringe), decoded by the cutout material only. Its x/y/z are biased by +1 (the
 * decoder subtracts 1, so a strip may reach below local 0), its sub-cell offset is in word B's fx/fy/fz, and its UV
 * comes from the corner bits (u = 1 on corners 1 and 2, v = 1 on corners 2 and 3) instead of the world projection.
 * Set it with `(a | FRINGE_BIT) >>> 0`.
 */
export const FRINGE_BIT = 1 << 31

/** How much of its colour a cut face keeps. */
export const CUT_SHADE = 0.72

/**
 * Word A normal code of a tilted roof vertex (blocks/roofs.ts): its normal is `ROOF_NORMALS[drop bits]` (no drop is
 * applied) and its x/y/z are stored + TILT_BIAS, so a roof's overhang may reach below a chunk's local 0. Codes 0–5 are the
 * axis faces; 7 is unused.
 */
export const TILT_NORMAL = 6
export const TILT_BIAS = 1

/** Word A of a tilted roof vertex at integer grid point (x, y, z) (−1..62), its sub-cell offset in word B as for shapes. */
export function packTilted(x: number, y: number, z: number, normalIndex: number, corner: number): number {
  return packA(x + TILT_BIAS, y + TILT_BIAS, z + TILT_BIAS, TILT_NORMAL, 0, corner, normalIndex)
}

/** Word A's fields; a tilted vertex (TILT_NORMAL) decodes its biased position back, drop 0, and its normal index as `tilt`. */
export function unpackA(a: number): { x: number; y: number; z: number; normal: number; ao: number; corner: number; drop: number; tilt?: number } {
  const normal = (a >>> 18) & 7, drop = (a >>> 25) & 31
  const x = a & 63, y = (a >>> 6) & 63, z = (a >>> 12) & 63, ao = (a >>> 21) & 3, corner = (a >>> 23) & 3
  if (normal === TILT_NORMAL) return { x: x - TILT_BIAS, y: y - TILT_BIAS, z: z - TILT_BIAS, normal, ao, corner, drop: 0, tilt: drop }
  return { x, y, z, normal, ao, corner, drop }
}

/**
 * Word B: texture layer(12) sky(4) block(4) fx(4) fy(4) fz(4). fx/fy/fz place a shaped block's corner between the integer
 * grid points of word A, in sixteenths: the vertex sits at (x + fx/16, y + fy/16 − drop/16, z + fz/16).
 */
export function packB(layer: number, sky: number, block: number, fx = 0, fy = 0, fz = 0): number {
  return (layer | (sky << 12) | (block << 16) | (fx << 20) | (fy << 24) | (fz << 28)) >>> 0
}
export function unpackB(b: number) {
  return { layer: b & 4095, sky: (b >>> 12) & 15, block: (b >>> 16) & 15, fx: (b >>> 20) & 15, fy: (b >>> 24) & 15, fz: (b >>> 28) & 15 }
}

/**
 * The layer field of a tone block's cutout vertex (BlockDef.tone; only in a world with tone blocks, which hold at most
 * 256 texture layers): the texture layer in bits 0–7, the voxel's tone level (state & 3) in bits 8–9 and a 2-bit hash of
 * its world cell in bits 10–11. Level 0 with jitter 0 is the plain layer.
 */
export function toneLayer(layer: number, level: number, jitter: number): number {
  return layer | (level << 8) | (jitter << 10)
}
