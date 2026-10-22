export const FACE = { PX: 0, NX: 1, PY: 2, NY: 3, PZ: 4, NZ: 5 } as const
export const FACE_NORMALS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
]

/** Word A: x(6) y(6) z(6) normal(3) ao(2) corner(2) drop(5) cut(1) reserved(1). */
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
/** How much of its colour a cut face keeps. */
export const CUT_SHADE = 0.72

export function unpackA(a: number) {
  return {
    x: a & 63, y: (a >>> 6) & 63, z: (a >>> 12) & 63, normal: (a >>> 18) & 7,
    ao: (a >>> 21) & 3, corner: (a >>> 23) & 3, drop: (a >>> 25) & 31,
  }
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
