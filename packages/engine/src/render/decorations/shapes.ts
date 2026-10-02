import { MAX_BLADES } from './defs.ts'

export interface DecorationArrays { position: Float32Array; info: Float32Array; index: Uint16Array }

function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296
}

/** MAX_BLADES tapered blades rooted in the unit cell; position.y is the 0–1 height fraction (scaled in the shader). */
export function tuftArrays(): DecorationArrays {
  const r = lcg(0x7f4a7c15)
  const position = new Float32Array(MAX_BLADES * 5 * 3)
  const info = new Float32Array(MAX_BLADES * 5 * 4)
  const index = new Uint16Array(MAX_BLADES * 9)
  for (let b = 0; b < MAX_BLADES; b++) {
    const rx = 0.08 + r() * 0.84, rz = 0.08 + r() * 0.84
    const yaw = r() * Math.PI, w = 0.05 + r() * 0.04, jitter = r()
    const dx = Math.cos(yaw), dz = Math.sin(yaw)
    const shape: readonly (readonly [number, number])[] = [[-w, 0], [w, 0], [-w * 0.6, 0.5], [w * 0.6, 0.5], [0, 1]]
    shape.forEach(([s, t], k) => {
      const v = b * 5 + k
      position.set([rx + s * dx, t, rz + s * dz], v * 3)
      info.set([b, jitter, rx, rz], v * 4)
    })
    const o = b * 5
    index.set([o, o + 1, o + 2, o + 1, o + 3, o + 2, o + 2, o + 3, o + 4], b * 9)
  }
  return { position, info, index }
}

/** A thin stem and two crossed petal quads around (0, 0); sizes in blocks. info.x: 0 stem, 1 petal; info.y: height fraction. */
export function flowerArrays(): DecorationArrays {
  const H = 0.42, P = 0.11, S = 0.015
  const verts: [number, number, number, number, number][] = [
    [-S, 0, 0, 0, 0], [S, 0, 0, 0, 0], [S, H, 0, 0, 1], [-S, H, 0, 0, 1],
    [-P, H - 0.02, -P, 1, 1], [P, H - 0.02, P, 1, 1], [P, H + 0.04, P, 1, 1], [-P, H + 0.04, -P, 1, 1],
    [-P, H - 0.02, P, 1, 1], [P, H - 0.02, -P, 1, 1], [P, H + 0.04, -P, 1, 1], [-P, H + 0.04, P, 1, 1],
  ]
  const position = new Float32Array(12 * 3)
  const info = new Float32Array(12 * 4)
  verts.forEach(([x, y, z, part, t], v) => { position.set([x, y, z], v * 3); info.set([part, t, 0, 0], v * 4) })
  const index = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11])
  return { position, info, index }
}
