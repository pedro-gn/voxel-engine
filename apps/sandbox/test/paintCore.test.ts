import { describe, expect, it } from 'vitest'
import { hashId, tileFbm, tileNoise, worley } from '../src/paint/noise.ts'
import { N, SIZE, createLayer, disc, hex, paint, rng, wrap } from '../src/paint/raster.ts'
import { shade } from '../src/paint/shade.ts'

describe('raster', () => {
  it('wraps coordinates onto the 64×64 torus', () => {
    expect(wrap(-1, 0)).toBe(SIZE - 1)
    expect(wrap(64, 64)).toBe(0)
    expect(wrap(3, -1)).toBe((SIZE - 1) * SIZE + 3)
  })
  it('stamps discs across the edges', () => {
    const hit = new Set<number>()
    disc(0, 0, 2, (i) => hit.add(i))
    expect(hit.has(wrap(-1, -1))).toBe(true)
    expect(hit.has(wrap(0, 0))).toBe(true)
  })
  it('seeds a repeatable generator', () => {
    const a = rng(5), b = rng(5)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })
})

describe('tileable noise', () => {
  const r = rng(9)
  it('repeats every SIZE pixels on both axes and stays in [0, 1)', () => {
    for (let k = 0; k < 50; k++) {
      const x = r() * SIZE, y = r() * SIZE
      const v = tileNoise(3, x, y, 8)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      expect(tileNoise(3, x + SIZE, y, 8)).toBeCloseTo(v, 9)
      expect(tileNoise(3, x, y - SIZE, 8, 4)).toBeCloseTo(tileNoise(3, x, y, 8, 4), 9)
      expect(tileFbm(4, x + SIZE, y + SIZE, 4, 3)).toBeCloseTo(tileFbm(4, x, y, 4, 3), 9)
      expect(worley(5, x + SIZE, y, 8).d).toBeCloseTo(worley(5, x, y, 8).d, 9)
    }
  })
  it('orders worley distances and hashes ids into [0, 1)', () => {
    const c = worley(5, 10.5, 20.5, 8)
    expect(c.d).toBeLessThanOrEqual(c.d2)
    expect(hashId(c.id)).toBeGreaterThanOrEqual(0)
    expect(hashId(c.id)).toBeLessThan(1)
  })
})

describe('shade', () => {
  it('keeps a flat layer close to its base colour and copies alpha', () => {
    const l = createLayer(hex('#808080'), 0.5, 0.5)
    const px = shade(l)
    expect(px.length).toBe(N * 4)
    for (let i = 0; i < N; i++) {
      expect(Math.abs(px[i * 4]! - 128)).toBeLessThanOrEqual(5)
      expect(px[i * 4 + 3]).toBe(128)
    }
  })
  it('lights slopes that face the top-left and darkens the far side', () => {
    const l = createLayer(hex('#808080'))
    disc(32, 32, 10, (i, d) => paint(l, i, hex('#808080'), 0.5 + 0.4 * (1 - d * d)))
    const px = shade(l, { jitter: 0 })
    expect(px[wrap(26, 26) * 4]!).toBeGreaterThan(px[wrap(38, 38) * 4]!)
  })
  it('darkens cavities', () => {
    const l = createLayer(hex('#808080'), 0.8)
    for (let y = 0; y < SIZE; y++) paint(l, wrap(32, y), hex('#808080'), 0.1)
    const px = shade(l, { highlight: 0, jitter: 0 })
    expect(px[wrap(32, 10) * 4]!).toBeLessThan(px[wrap(10, 10) * 4]! - 20)
  })
  it('is deterministic', () => {
    const l = createLayer(hex('#6699cc'))
    expect(shade(l, { seed: 3 })).toEqual(shade(l, { seed: 3 }))
  })
})
