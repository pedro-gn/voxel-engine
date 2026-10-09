import { describe, expect, it } from 'vitest'
import { bindCollision } from '../src/interact/collision.ts'
import { UNDERWATER, UnderwaterFade, cameraInLiquid, fogDensity } from '../src/render/underwater.ts'
import { packVoxel } from '../src/world/voxel.ts'
import { ID, testRegistry } from './helpers.ts'

const reg = testRegistry()
function pool() {
  const size: [number, number, number] = [16, 16, 16]
  const cells = new Map<number, number>()
  const key = (x: number, y: number, z: number) => x + size[0] * (z + size[2] * y)
  const get = (x: number, y: number, z: number) => cells.get(key(x, y, z)) ?? 0
  for (let y = 0; y < 4; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) cells.set(key(x, y, z), ID.stone)
  for (let y = 4; y < 8; y++) for (let z = 4; z < 12; z++) for (let x = 4; x < 12; x++) cells.set(key(x, y, z), packVoxel(ID.water, 7))
  cells.set(key(2, 4, 2), packVoxel(ID.water, 3))                 // a half-full cell: surface at y = 4.5
  return bindCollision({ size, get, solid: reg.solid, liquid: reg.liquid, source: reg.source })
}

describe('cameraInLiquid', () => {
  const c = pool()
  it('is true below a surface and false above it', () => {
    expect(cameraInLiquid(c, reg.liquid, 8, 6, 8)).toBe(true)
    expect(cameraInLiquid(c, reg.liquid, 8, 7.99, 8)).toBe(true)
    expect(cameraInLiquid(c, reg.liquid, 8, 8.01, 8)).toBe(false)
    expect(cameraInLiquid(c, reg.liquid, 1, 6, 1)).toBe(false)     // beside the pool
    expect(cameraInLiquid(c, reg.liquid, 2.5, 4.4, 2.5)).toBe(true)  // inside a partial cell, under its fill
    expect(cameraInLiquid(c, reg.liquid, 2.5, 4.6, 2.5)).toBe(false) // inside a partial cell, above its fill
  })
  it('is false outside the world, for non-finite positions, and with no liquid block registered', () => {
    expect(cameraInLiquid(c, reg.liquid, 8, 100, 8)).toBe(false)
    expect(cameraInLiquid(c, reg.liquid, -5, 6, 8)).toBe(false)
    expect(cameraInLiquid(c, reg.liquid, Number.NaN, 6, 8)).toBe(false)
    let calls = 0
    const counting = { liquidAt: (x: number, y: number, z: number) => { calls++; return c.liquidAt(x, y, z) } }
    expect(cameraInLiquid(counting, new Uint8Array(reg.liquid.length), 8, 6, 8)).toBe(false)
    expect(calls).toBe(0)                                          // skipped, not queried
  })
})

describe('UnderwaterFade', () => {
  it('ramps in and out linearly over the fade time, reaching exactly 1 and 0', () => {
    const f = new UnderwaterFade()
    expect(f.amount).toBe(0)
    expect(f.update(0.05, true)).toBeCloseTo(0.5, 6)
    expect(f.update(0.06, true)).toBe(1)
    expect(f.update(0.02, true)).toBe(1)
    expect(f.update(0.05, false)).toBeCloseTo(0.5, 6)
    expect(f.update(0.07, false)).toBe(0)
  })
  it('stays at exactly 0 above water', () => {
    const f = new UnderwaterFade()
    for (let i = 0; i < 100; i++) f.update(1 / 60, false)
    expect(f.amount).toBe(0)
  })
  it('clamps dt to 0.1 and treats a non-finite or negative dt as 0', () => {
    const f = new UnderwaterFade(0.5)
    expect(f.update(10, true)).toBeCloseTo(0.2, 6)
    expect(f.update(Number.NaN, true)).toBeCloseTo(0.2, 6)
    expect(f.update(-1, true)).toBeCloseTo(0.2, 6)
  })
  it('switches at once with a zero fade time', () => {
    const f = new UnderwaterFade(0)
    expect(f.update(1 / 60, true)).toBe(1)
    expect(f.update(1 / 60, false)).toBe(0)
  })
})

describe('underwater tunables', () => {
  it('fogs 90 % of the way at 12 blocks', () => {
    const k = fogDensity(UNDERWATER.fog90)
    expect(UNDERWATER.fog90).toBe(12)
    expect(1 - Math.exp(-k * 12)).toBeCloseTo(0.9, 9)
  })
  it('wobbles gently: 0.001 UV at 0.8 rad/s (user look check 2026-10-09: 0.003 at 2.1 was too strong)', () => {
    expect(UNDERWATER.wobble).toBe(0.001)
    expect(UNDERWATER.wobbleSpeed).toBe(0.8)
  })
  it('is frozen', () => {
    expect(Object.isFrozen(UNDERWATER)).toBe(true)
  })
})
