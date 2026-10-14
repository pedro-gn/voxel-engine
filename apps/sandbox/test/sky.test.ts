import { describe, expect, it } from 'vitest'
import { Simulation, createWorldBuffers, fbm2 } from '@elovox/engine/testing'
import { BLOCKS } from '../src/blocks.ts'
import { SKY_CENTRE, SKY_RADIUS, SKY_SIZE, SKY_SPRING, SKY_WORKER_OPTIONS, WANDER_UNITS, createWander, skyColumn, skyGenerator, type WanderStats } from '../src/scenes/sky.ts'

const noise = (x: number, z: number) => fbm2(1234, x, z, 1)
const topOf = (col: unknown[]) => { for (let y = col.length - 1; y >= 0; y--) if (col[y] !== null) return y; return -1 }
const bottomOf = (col: unknown[]) => col.findIndex(b => b !== null)

describe('skyColumn', () => {
  it('a grass-topped island, deep in the middle, thin at the rim, nothing beyond it', () => {
    const mid = skyColumn(SKY_CENTRE, SKY_CENTRE - 10, noise)
    expect(mid[topOf(mid)]).toBe('grass')
    expect(topOf(mid)).toBeGreaterThan(45)
    expect(bottomOf(mid)).toBeLessThan(30)
    const rim = skyColumn(SKY_CENTRE, SKY_CENTRE + SKY_RADIUS - 8, noise)
    expect(topOf(rim) - bottomOf(rim)).toBeLessThan(12)
    expect(skyColumn(5, 5, noise).every(b => b === null)).toBe(true)
  })
  it('an overhanging shelf on the west side, open below', () => {
    const shelf = skyColumn(SKY_CENTRE - SKY_RADIUS - 6, SKY_CENTRE, noise)
    expect(topOf(shelf)).toBeGreaterThan(0)
    expect(topOf(shelf) - bottomOf(shelf)).toBe(3)
  })
  it('a spring at the head of a walled stream', () => {
    const head = skyColumn(SKY_SPRING.x, SKY_SPRING.z, noise)
    expect(head[topOf(head)]).toBe('spring')
    const bank = skyColumn(SKY_SPRING.x + 10, SKY_SPRING.z + 2, noise), bed = skyColumn(SKY_SPRING.x + 10, SKY_SPRING.z, noise)
    expect(topOf(bank)).toBeGreaterThanOrEqual(topOf(bed) + 2)
  })
})

describe('the sky scene in the simulation', () => {
  it('runs the wander demo in a void world: three units, publications, no water below the island', () => {
    const sim = new Simulation({ buffers: createWorldBuffers([...SKY_SIZE]), blocks: BLOCKS, seed: 1234, randomTicksPerChunk: 0, log: () => {}, workers: SKY_WORKER_OPTIONS, systems: [createWander()] })
    sim.configure(skyGenerator, {})
    sim.generate(skyGenerator)
    expect(sim.voidWorld).toBe(true)
    let last: WanderStats | undefined
    for (let i = 0; i < 400; i++) { const r = sim.step(); for (const p of r.systems ?? []) last = p.payload as WanderStats }
    expect(last?.units).toBe(WANDER_UNITS)
    expect(sim.workers!.units.size).toBe(WANDER_UNITS)
    let below = 0
    for (let z = 0; z < SKY_SIZE[2]; z += 2) for (let x = 0; x < SKY_SIZE[0]; x += 2) for (let y = 0; y < 15; y++) if (sim.water.depthAt(x, y, z) > 0) below++
    expect(below).toBe(0)
    // The units dig (and later build back) without any of them falling off or hanging.
    for (let i = 0; i < 2400 && !(last && last.dug >= 1 && last.built >= 1); i++) { const r = sim.step(); for (const p of r.systems ?? []) last = p.payload as WanderStats }
    expect(last!.dug).toBeGreaterThanOrEqual(1)
    expect(last!.built).toBeGreaterThanOrEqual(1)
    expect(last!.died).toBe(0)
  }, 120_000)
})
