import { describe, expect, it } from 'vitest'
import { cellular2, cellular3 } from '../src/noise/cellular.ts'
import { makeNoise2, makeNoise3, type NoiseDef } from '../src/noise/def.ts'
import { billow2, fbm2, fbm3, ridged2 } from '../src/noise/fractal.ts'
import { perlin2, perlin3 } from '../src/noise/gradient.ts'

const O = { octaves: 4, lacunarity: 2, gain: 0.5 }

function sample2(f: (x: number, z: number) => number, n = 4000): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(f(i * 0.173 + 0.31, i * 0.291 - 7.7))
  return out
}

describe('perlin2 / perlin3', () => {
  it('is zero on lattice points, continuous, and in [-1, 1]', () => {
    expect(perlin2(3, 4, -9)).toBe(0)
    expect(perlin3(3, 4, 5, -9)).toBe(0)
    expect(Math.abs(perlin2(3, 10.5, 10.5) - perlin2(3, 10.5001, 10.5))).toBeLessThan(0.001)
    for (const v of sample2((x, z) => perlin2(9, x, z))) expect(Math.abs(v)).toBeLessThanOrEqual(1)
    for (const v of sample2((x, z) => perlin3(9, x, z * 0.5, z))) expect(Math.abs(v)).toBeLessThanOrEqual(1)
  })
  it('uses most of its range', () => {
    const vs = sample2((x, z) => perlin2(9, x, z))
    expect(Math.max(...vs)).toBeGreaterThan(0.6)
    expect(Math.min(...vs)).toBeLessThan(-0.6)
  })
  it('matches golden values', () => {
    expect([perlin2(1234, 3.7, -2.2), perlin3(1234, 3.7, 8.1, -2.2)].map((v) => v.toFixed(12))).toEqual(GOLDEN_PERLIN)
  })
})

describe('fractal noise', () => {
  it('keeps fbm and billow in [-1, 1] and ridged in [0, 1]', () => {
    for (const v of sample2((x, z) => fbm2(5, x, z, O))) expect(Math.abs(v)).toBeLessThanOrEqual(1)
    for (const v of sample2((x, z) => billow2(5, x, z, O))) expect(Math.abs(v)).toBeLessThanOrEqual(1)
    for (const v of sample2((x, z) => ridged2(5, x, z, O))) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1) }
    for (const v of sample2((x, z) => fbm3(5, x, x - z, z, O))) expect(Math.abs(v)).toBeLessThanOrEqual(1)
  })
  it('matches golden values', () => {
    expect([fbm2(77, 1.25, 2.5, O), ridged2(77, 1.25, 2.5, O)].map((v) => v.toFixed(12))).toEqual(GOLDEN_FRACTAL)
  })
})

describe('cellular', () => {
  it('stays in [0, 1]', () => {
    for (const v of sample2((x, z) => cellular2(4, x, z))) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1) }
    for (const v of sample2((x, z) => cellular3(4, x, z, x))) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1) }
  })
})

describe('makeNoise2 / makeNoise3', () => {
  const types: NoiseDef['type'][] = ['fbm', 'ridged', 'billow', 'cellular']
  it.each(types)('%s samples stay in [0, 1]', (type) => {
    const n2 = makeNoise2({ type, scale: 20 }, 42)
    const n3 = makeNoise3({ type, scale: 20 }, 42)
    for (let i = 0; i < 2000; i++) {
      const a = n2(i * 1.7, i * -2.3), b = n3(i * 1.7, i * 0.4, i * -2.3)
      expect(a).toBeGreaterThanOrEqual(0); expect(a).toBeLessThanOrEqual(1)
      expect(b).toBeGreaterThanOrEqual(0); expect(b).toBeLessThanOrEqual(1)
    }
  })
  it('scales features: a larger scale changes slower', () => {
    const fine = makeNoise2({ scale: 4 }, 1), coarse = makeNoise2({ scale: 64 }, 1)
    let dFine = 0, dCoarse = 0
    for (let i = 0; i < 500; i++) { dFine += Math.abs(fine(i, 0) - fine(i + 1, 0)); dCoarse += Math.abs(coarse(i, 0) - coarse(i + 1, 0)) }
    expect(dCoarse).toBeLessThan(dFine / 4)
  })
  it('is deterministic and decorrelates with def.seed', () => {
    const a = makeNoise2({ scale: 16 }, 1), b = makeNoise2({ scale: 16, seed: 1 }, 1), a2 = makeNoise2({ scale: 16 }, 1)
    expect(a(10.5, 3.25)).toBe(a2(10.5, 3.25))
    expect(a(10.5, 3.25)).not.toBe(b(10.5, 3.25))
  })
  it('warps the domain', () => {
    const plain = makeNoise2({ scale: 16 }, 1), warped = makeNoise2({ scale: 16, warp: { scale: 32, amount: 12 } }, 1)
    let diff = 0
    for (let i = 0; i < 100; i++) diff += Math.abs(plain(i * 3, i * 2) - warped(i * 3, i * 2))
    expect(diff).toBeGreaterThan(1)
  })
})

const GOLDEN_PERLIN = ['-0.212200062533', '-0.275491585529']
const GOLDEN_FRACTAL = ['0.326661480368', '0.517216437445']
