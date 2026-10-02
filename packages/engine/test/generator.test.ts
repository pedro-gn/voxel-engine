import { describe, expect, it } from 'vitest'
import { defineGenerator, valueNoise2 } from '../src/sim/generator.ts'
import { Simulation } from '../src/sim/simulation.ts'
import { testGenerator } from '../src/sim/testGenerator.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { AIR, skyLight } from '../src/world/voxel.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'

const sim = () => new Simulation({ buffers: createWorldBuffers([64, 64, 64]), blocks: TEST_BLOCKS, seed: 5 })

describe('valueNoise2', () => {
  it('is deterministic, in range and smooth', () => {
    expect(valueNoise2(1, 3.25, 7.5)).toBe(valueNoise2(1, 3.25, 7.5))
    expect(valueNoise2(1, 3.25, 7.5)).not.toBe(valueNoise2(2, 3.25, 7.5))
    for (let i = 0; i < 200; i++) {
      const n = valueNoise2(9, i * 0.37, i * 0.11)
      expect(n).toBeGreaterThanOrEqual(0)
      expect(n).toBeLessThan(1)
    }
    expect(Math.abs(valueNoise2(3, 10, 10) - valueNoise2(3, 10.001, 10))).toBeLessThan(0.01)
  })
})

describe('Simulation.generate', () => {
  it('fills columns and stores uniform chunks without slots', () => {
    const s = sim()
    const flat = defineGenerator({
      generateColumn(ctx) {
        for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) for (let y = 0; y < 32; y++) ctx.set(lx, y, lz, ctx.id('stone'))
      },
    })
    const all = s.generate(flat)
    expect(all).toHaveLength(8)
    expect(s.store.getVoxel(3, 31, 3)).toBe(ID.stone)
    expect(s.store.getVoxel(3, 32, 3)).toBe(AIR)
    expect(s.store.slotsUsed()).toBe(0)
    expect(Array.from(s.store.versions).every((v) => (v & 1) === 0)).toBe(true)
  })

  it('rejects out-of-column writes', () => {
    const bad = defineGenerator({ generateColumn(ctx) { ctx.set(32, 0, 0, 1) } })
    expect(() => sim().generate(bad)).toThrow(RangeError)
  })

  it('builds lit layered terrain with the test generator and leaves every chunk version even', () => {
    const s = sim()
    s.generate(testGenerator)
    expect(Array.from(s.store.versions).every((v) => (v & 1) === 0)).toBe(true)
    let grassTops = 0
    for (let x = 0; x < 64; x += 7) for (let z = 0; z < 64; z += 7) {
      let y = 63
      while (y > 0 && s.store.getVoxel(x, y, z) === AIR) y--
      if (s.store.getVoxel(x, y, z) === ID.grass) grassTops++
      expect(s.store.getVoxel(x, 0, z)).toBe(ID.stone)
      expect(skyLight(s.store.getLight(x, y + 1, z))).toBe(15)
    }
    expect(grassTops).toBeGreaterThan(0)
  })
})
