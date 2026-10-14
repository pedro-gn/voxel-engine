/** 6364136223846793005 and 1442695040888963407 (PCG's default multiplier and increment) as 32-bit halves. */
const MUL_HI = 0x5851f42d, MUL_LO = 0x4c957f2d
const INC_HI = 0x14057b7e, INC_LO = 0xf767814f

/**
 * PCG-XSH-RR 32-bit output, 64-bit state. The state is kept as two unsigned 32-bit halves and
 * multiplied in 16-bit limbs, so every step is exact on every engine (and needs no BigInt).
 */
export class Pcg32 {
  private hi = 0
  private lo = 0

  constructor(seed = 0) { this.reseed(seed) }

  reseed(seed: number): void {
    this.hi = 0; this.lo = 0
    this.step()
    const lo = this.lo + (seed >>> 0)
    this.lo = lo >>> 0
    this.hi = (this.hi + (lo > 0xffffffff ? 1 : 0)) >>> 0
    this.step()
  }

  nextU32(): number {
    const oh = this.hi, ol = this.lo
    this.step()
    // ((old >> 18) ^ old) >> 27, low 32 bits; rot = old >> 59
    const xh = oh ^ (oh >>> 18), xl = ol ^ ((ol >>> 18) | (oh << 14))
    const xorshifted = ((xl >>> 27) | (xh << 5)) >>> 0
    const rot = oh >>> 27
    return ((xorshifted >>> rot) | (xorshifted << ((32 - rot) & 31))) >>> 0
  }

  next(): number { return this.nextU32() / 4294967296 }

  /** The 64-bit state as [hi, lo], for a save. */
  state(): [number, number] { return [this.hi, this.lo] }
  setState(s: readonly [number, number]): void { this.hi = s[0] >>> 0; this.lo = s[1] >>> 0 }

  nextInt(n: number): number { return Math.floor(this.next() * n) }

  /** state = state · MUL + INC (mod 2^64). */
  private step(): void {
    const sh = this.hi, sl = this.lo
    // sl · MUL_LO as a full 64-bit product, in 16-bit limbs (every partial product is exact in a double)
    const a0 = sl & 0xffff, a1 = sl >>> 16, b0 = MUL_LO & 0xffff, b1 = MUL_LO >>> 16
    const p00 = a0 * b0, p01 = a0 * b1, p10 = a1 * b0
    const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff)
    const lo = (((mid & 0xffff) << 16) | (p00 & 0xffff)) >>> 0
    let hi = a1 * b1 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16)
    // the cross terms only reach the high half
    hi = (hi + Math.imul(sh, MUL_LO) + Math.imul(sl, MUL_HI)) >>> 0
    const lo2 = lo + INC_LO
    this.lo = lo2 >>> 0
    this.hi = (hi + INC_HI + (lo2 > 0xffffffff ? 1 : 0)) >>> 0
  }
}
function fmix(h: number): number {
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h
}

export function hash32(...values: number[]): number {
  let h = 0x811c9dc5
  for (const v of values) h = Math.imul(h ^ fmix(v | 0), 0x01000193)
  return fmix(h) >>> 0
}
