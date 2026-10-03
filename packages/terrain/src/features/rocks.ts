import { hash3, unit } from '../noise/hash.ts'
import type { Put } from './rand.ts'

/** A boulder of radius r on the ground at (x, top, z), partly buried; overwrites whatever is there. */
export function stampRock(x: number, top: number, z: number, r: number, rnd: () => number, rock: number, put: Put): void {
  const seed = Math.floor(rnd() * 2 ** 31)
  const cy = top + Math.round(r * 0.2)
  const ry = r * 0.75
  const R = Math.ceil(r * 1.07)
  for (let dy = -R; dy <= R; dy++) for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
    const q = (dx / r) ** 2 + (dy / ry) ** 2 + (dz / r) ** 2
    if (q <= 1 + 0.25 * (unit(hash3(seed, x + dx, cy + dy, z + dz)) - 0.5)) put(x + dx, cy + dy, z + dz, rock, true)
  }
}
