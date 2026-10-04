export const FACE = { PX: 0, NX: 1, PY: 2, NY: 3, PZ: 4, NZ: 5 } as const
export const FACE_NORMALS: readonly (readonly [number, number, number])[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
]

/** Word A: x(6) y(6) z(6) normal(3) ao(2) corner(2) drop(5) reserved(2). */
export function packA(x: number, y: number, z: number, normal: number, ao: number, corner: number, drop = 0): number {
  return (x | (y << 6) | (z << 12) | (normal << 18) | (ao << 21) | (corner << 23) | (drop << 25)) >>> 0
}
export function unpackA(a: number) {
  return {
    x: a & 63, y: (a >>> 6) & 63, z: (a >>> 12) & 63, normal: (a >>> 18) & 7,
    ao: (a >>> 21) & 3, corner: (a >>> 23) & 3, drop: (a >>> 25) & 31,
  }
}

/** Word B: texture layer(12) sky(4) block(4) quad w(6) quad h(6). */
export function packB(layer: number, sky: number, block: number, w: number, h: number): number {
  return (layer | (sky << 12) | (block << 16) | (w << 20) | (h << 26)) >>> 0
}
export function unpackB(b: number) {
  return { layer: b & 4095, sky: (b >>> 12) & 15, block: (b >>> 16) & 15, w: (b >>> 20) & 63, h: (b >>> 26) & 63 }
}

/** Liquid flow codes (5 bits): MOVING, STEEP, and a direction in bits 0-2 (0 = +x, then 45° steps toward +z). */
export const FLOW = { STILL: 0, STEEP: 8, MOVING: 16 } as const

export function flowCode(dir: number, steep: boolean): number {
  return FLOW.MOVING | (steep ? FLOW.STEEP : 0) | (dir & 7)
}

/** Packs a flow code into a liquid vertex: bits 30-31 of word A (reserved) and bits 9-11 of word B (liquid layers stay below 512). */
export function packFlow(a: number, b: number, code: number): [number, number] {
  return [(a | ((code & 3) << 30)) >>> 0, (b | (((code >> 2) & 7) << 9)) >>> 0]
}

export function unpackFlow(a: number, b: number): number {
  return ((a >>> 30) & 3) | (((b >>> 9) & 7) << 2)
}
