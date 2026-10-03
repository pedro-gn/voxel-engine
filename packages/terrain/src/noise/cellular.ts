import { hash2, hash3, unit } from './hash.ts'

/** Distance to the nearest jittered feature point (Worley F1), clamped to [0, 1]. */
export function cellular2(seed: number, x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z)
  let best = Infinity
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const cx = ix + dx, cz = iz + dz
    const px = cx + unit(hash2(seed, cx, cz))
    const pz = cz + unit(hash2(seed ^ 0x5bd1e995, cx, cz))
    const d = (px - x) * (px - x) + (pz - z) * (pz - z)
    if (d < best) best = d
  }
  return Math.min(1, Math.sqrt(best))
}

export function cellular3(seed: number, x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z)
  let best = Infinity
  for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const cx = ix + dx, cy = iy + dy, cz = iz + dz
    const px = cx + unit(hash3(seed, cx, cy, cz))
    const py = cy + unit(hash3(seed ^ 0x5bd1e995, cx, cy, cz))
    const pz = cz + unit(hash3(seed ^ 0x27d4eb2f, cx, cy, cz))
    const d = (px - x) * (px - x) + (py - y) * (py - y) + (pz - z) * (pz - z)
    if (d < best) best = d
  }
  return Math.min(1, Math.sqrt(best))
}
