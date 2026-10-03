import { describe, expect, it } from 'vitest'
import { defineGenerator, type GeneratorModule } from '../src/sim/generator.ts'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'

const SIZE = [128, 64, 96] as const

/** Ground at y 20 with a stone roof over x 40..69 at y 30, a torch under it, and a glass pillar. */
function scene(variant: 'a' | 'b'): GeneratorModule {
  return defineGenerator({
    generateColumn(ctx, cx, cz) {
      for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
        const x = cx * 32 + lx, z = cz * 32 + lz
        const ground = variant === 'b' && x > 44 && x < 52 && z > 8 && z < 20 ? 12 : 20 // a pit in b
        for (let y = 0; y < ground; y++) ctx.set(lx, y, lz, ID.stone)
        const roof = variant === 'a' ? x >= 40 && x < 70 : x >= 34 && x < 50 && z < 40
        if (roof && z < 50) ctx.set(lx, 30, lz, ID.stone)
        if (variant === 'a' && x === 50 && z === 10) ctx.set(lx, 21, lz, ID.torch)
        if (variant === 'b' && x === 40 && z === 20) ctx.set(lx, 21, lz, ID.torch)
        if (x === 75 && z === 30) for (let y = 20; y < 40; y++) ctx.set(lx, y, lz, ID.glass)
      }
    },
  })
}

/** Column (1, 0) — x 32..63, z 0..31 — from b, everything else from a. */
const mixed = defineGenerator({
  generateColumn(ctx, cx, cz) {
    (cx === 1 && cz === 0 ? scene('b') : scene('a')).generateColumn(ctx, cx, cz)
  },
})

function world(gen: GeneratorModule): Simulation {
  const sim = new Simulation({ buffers: createWorldBuffers([...SIZE]), blocks: TEST_BLOCKS, seed: 1 })
  sim.generate(gen)
  return sim
}

function sameLight(a: Simulation, b: Simulation): number {
  let diff = 0
  for (let y = 0; y < SIZE[1]; y++) for (let z = 0; z < SIZE[2]; z++) for (let x = 0; x < SIZE[0]; x++) {
    if (a.store.getVoxel(x, y, z) !== b.store.getVoxel(x, y, z) || a.store.getLight(x, y, z) !== b.store.getLight(x, y, z)) diff++
  }
  return diff
}

describe('LightEngine.relightRegion', () => {
  it('gives the same light as generating the changed world from scratch', () => {
    const fresh = world(mixed)
    const replaced = (relight: boolean) => {
      const sim = world(scene('a'))
      const column = new Uint16Array(32 * 32 * SIZE[1])
      sim.generateColumnData(scene('b'), 1, 0, column)
      sim.applyColumn(1, 0, column)
      if (relight) sim.light.relightRegion(32, 0, 64, 32)
      sim.store.commit()
      return sim
    }
    expect(sameLight(replaced(false), fresh)).toBeGreaterThan(100) // the test is not vacuous
    expect(sameLight(replaced(true), fresh)).toBe(0)
  })

  it('is a no-op on light when nothing changed', () => {
    const sim = world(scene('a'))
    sim.light.relightRegion(32, 32, 96, 64)
    sim.store.commit()
    expect(sameLight(sim, world(scene('a')))).toBe(0)
  })

  it('handles an area on the world edge', () => {
    const sim = world(scene('a'))
    const column = new Uint16Array(32 * 32 * SIZE[1])
    sim.generateColumnData(scene('b'), 0, 0, column)
    sim.applyColumn(0, 0, column)
    sim.light.relightRegion(0, 0, 32, 32)
    sim.store.commit()
    const edge = defineGenerator({ generateColumn(ctx, cx, cz) { (cx === 0 && cz === 0 ? scene('b') : scene('a')).generateColumn(ctx, cx, cz) } })
    expect(sameLight(sim, world(edge))).toBe(0)
  })
})
