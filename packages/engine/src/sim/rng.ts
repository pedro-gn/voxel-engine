const MULT = 6364136223846793005n
const INC = 1442695040888963407n
const MASK64 = 0xffffffffffffffffn

/** PCG-XSH-RR 32-bit output, 64-bit state. BigInt keeps it exact on every engine. */
export class Pcg32 {
  private state = 0n

  constructor(seed = 0) { this.reseed(seed) }

  reseed(seed: number): void {
    this.state = 0n
    this.step()
    this.state = (this.state + BigInt(seed >>> 0)) & MASK64
    this.step()
  }

  nextU32(): number {
    const old = this.state
    this.step()
    const xorshifted = Number((((old >> 18n) ^ old) >> 27n) & 0xffffffffn)
    const rot = Number(old >> 59n)
    return ((xorshifted >>> rot) | (xorshifted << ((32 - rot) & 31))) >>> 0
  }

  next(): number { return this.nextU32() / 4294967296 }

  nextInt(n: number): number { return Math.floor(this.next() * n) }

  private step(): void { this.state = (this.state * MULT + INC) & MASK64 }
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
