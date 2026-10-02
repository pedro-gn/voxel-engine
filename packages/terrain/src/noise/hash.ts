/** Murmur3 32-bit finalizer. Returns an unsigned 32-bit integer. */
export function fmix(h: number): number {
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** Hash of a seed and two integers. Fixed arity (no rest array), so hot loops stay allocation-free. */
export function hash2(seed: number, x: number, z: number): number {
  let h = fmix((seed | 0) ^ 0x9e3779b9)
  h = fmix(h ^ Math.imul(x | 0, 0x27d4eb2d))
  return fmix(h ^ Math.imul(z | 0, 0x165667b1))
}

export function hash3(seed: number, x: number, y: number, z: number): number {
  let h = fmix((seed | 0) ^ 0x9e3779b9)
  h = fmix(h ^ Math.imul(x | 0, 0x27d4eb2d))
  h = fmix(h ^ Math.imul(y | 0, 0x1b873593))
  return fmix(h ^ Math.imul(z | 0, 0x165667b1))
}

/** Maps a 32-bit hash to [0, 1). */
export function unit(h: number): number { return h / 4294967296 }
