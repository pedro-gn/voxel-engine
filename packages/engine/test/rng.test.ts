import { describe, expect, it } from 'vitest'
import { Pcg32, hash32 } from '../src/sim/rng.ts'

/** Pcg32(42)'s first draws, from the BigInt implementation the 32-bit-halves one replaced. */
const GOLDEN_42 = [3270867926, 1795671209, 1924641435, 1143034755]

/** The textbook PCG-XSH-RR step in BigInt: Pcg32 must match it draw for draw. */
class ReferencePcg32 {
  private state = 0n
  constructor(seed: number) {
    this.step()
    this.state = (this.state + BigInt(seed >>> 0)) & 0xffffffffffffffffn
    this.step()
  }
  nextU32(): number {
    const old = this.state
    this.step()
    const xorshifted = Number((((old >> 18n) ^ old) >> 27n) & 0xffffffffn)
    const rot = Number(old >> 59n)
    return ((xorshifted >>> rot) | (xorshifted << ((32 - rot) & 31))) >>> 0
  }
  private step(): void { this.state = (this.state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn }
}

describe('Pcg32', () => {
  it('matches the 64-bit reference PCG-XSH-RR stream exactly', () => {
    for (const seed of [0, 1, 7, 1234, 99, -5, 2 ** 31, 0xffffffff, 123456789]) {
      const a = new Pcg32(seed), ref = new ReferencePcg32(seed)
      for (let i = 0; i < 5000; i++) expect(a.nextU32()).toBe(ref.nextU32())
    }
    // and a fixed golden, so a change to both cannot slip through
    const g = new Pcg32(42)
    expect(Array.from({ length: 4 }, () => g.nextU32())).toEqual(GOLDEN_42)
  })
  it('is reproducible per seed', () => {
    const a = new Pcg32(1234), b = new Pcg32(1234), c = new Pcg32(1235)
    const sa = Array.from({ length: 8 }, () => a.nextU32())
    const sb = Array.from({ length: 8 }, () => b.nextU32())
    const sc = Array.from({ length: 8 }, () => c.nextU32())
    expect(sa).toEqual(sb)
    expect(sa).not.toEqual(sc)
  })
  it('reseed restarts the stream', () => {
    const a = new Pcg32(7)
    const first = a.nextU32()
    a.nextU32()
    a.reseed(7)
    expect(a.nextU32()).toBe(first)
  })
  it('produces values in range with a sane mean', () => {
    const r = new Pcg32(99)
    let sum = 0
    for (let i = 0; i < 10_000; i++) {
      const u = r.nextU32()
      expect(u).toBeGreaterThanOrEqual(0)
      expect(u).toBeLessThanOrEqual(0xffffffff)
      const f = r.next()
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThan(1)
      sum += f
      const k = r.nextInt(6)
      expect(Number.isInteger(k) && k >= 0 && k < 6).toBe(true)
    }
    expect(sum / 10_000).toBeGreaterThan(0.45)
    expect(sum / 10_000).toBeLessThan(0.55)
  })
})

describe('hash32', () => {
  it('is deterministic, unsigned and order-sensitive', () => {
    expect(hash32(1, 2, 3)).toBe(hash32(1, 2, 3))
    expect(hash32(1, 2, 3)).not.toBe(hash32(3, 2, 1))
    expect(hash32(0)).toBeGreaterThanOrEqual(0)
    expect(hash32(-5)).toBeGreaterThanOrEqual(0)
  })
})
