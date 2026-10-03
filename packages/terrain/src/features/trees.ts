import type { TreeKind } from '../doc/types.ts'
import { hash3, unit } from '../noise/hash.ts'
import type { Put } from './rand.ts'

export interface TreeBlocks { log: number; leaves: number; pineLeaves: number }

/** Tallest tree above its base, so placement can keep trees inside the world. */
export const MAX_TREE_HEIGHT = 12

/** A leaf ellipsoid with a ragged outer shell (deterministic per voxel). */
function leafBall(cx: number, cy: number, cz: number, r: number, squash: number, leaves: number, seed: number, put: Put): void {
  const R = Math.ceil(r)
  const inner = (r - 0.8) * (r - 0.8)
  for (let dy = -R; dy <= R; dy++) for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
    const d2 = dx * dx + dy * squash * (dy * squash) + dz * dz
    if (d2 > r * r) continue
    if (d2 > inner && unit(hash3(seed, cx + dx, cy + dy, cz + dz)) < 0.35) continue
    put(cx + dx, cy + dy, cz + dz, leaves, false)
  }
}

/** Stamps a tree standing on (x, base - 1, z): its trunk starts at y = base. */
export function stampTree(kind: TreeKind, x: number, base: number, z: number, rnd: () => number, b: TreeBlocks, put: Put): void {
  const seed = Math.floor(rnd() * 2 ** 31)
  if (kind === 'bush') {
    put(x, base, z, b.log, false)
    leafBall(x, base + 1, z, 1.7, 1.3, b.leaves, seed, put)
    return
  }
  if (kind === 'pine') {
    const th = 7 + Math.floor(rnd() * 4)
    for (let y = base; y < base + th; y++) put(x, y, z, b.log, false)
    const y0 = base + 2, span = th
    for (let y = y0; y <= base + th; y++) {
      let r = 3.4 * (1 - (y - y0) / span) + 0.5
      if ((y - base) % 2 === 1) r *= 0.7
      const R = Math.ceil(r)
      for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dz * dz <= r * r) put(x + dx, y, z + dz, b.pineLeaves, false)
      }
    }
    put(x, base + th, z, b.pineLeaves, false)
    put(x, base + th + 1, z, b.pineLeaves, false)
    return
  }
  // broadleaf
  const th = 4 + Math.floor(rnd() * 3)
  for (let y = base; y < base + th; y++) put(x, y, z, b.log, false)
  const cy = base + th
  leafBall(x, cy, z, 2.6, 1.25, b.leaves, seed, put)
  for (let k = 0; k < 3; k++) {
    const a = rnd() * Math.PI * 2
    const dx = Math.round(Math.cos(a) * 2), dz = Math.round(Math.sin(a) * 2), dy = Math.floor(rnd() * 3) - 1
    leafBall(x + dx, cy + dy, z + dz, 1.8 + rnd() * 0.6, 1.25, b.leaves, seed + k + 1, put)
  }
}
