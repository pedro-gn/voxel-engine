import { describe, expect, it } from 'vitest'
import type { BlockDef } from '../src/blocks/registry.ts'
import { Simulation, type TickResult } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { B, WATER_BLOCKS, spring } from './waterHelpers.ts'

type Fill = (x: number, y: number, z: number) => number
type Gen = { set(x: number, y: number, z: number, v: number): void }
function voidGen(fill: Fill, isVoid: boolean, height: number) {
  return {
    configure: () => (isVoid ? { void: true } : undefined),
    generateColumn(ctx: Gen, cx: number, cz: number) {
      for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) for (let y = 0; y < height; y++) { const v = fill(cx * 32 + lx, y, cz * 32 + lz); if (v) ctx.set(lx, y, lz, v) }
    },
  }
}
function voidSim(fill: Fill, opts: { void?: boolean } = {}) {
  const logs: string[] = []
  const sim = new Simulation({ buffers: createWorldBuffers([64, 64, 64]), blocks: WATER_BLOCKS, seed: 2, randomTicksPerChunk: 0, water: { debug: true }, log: m => logs.push(m) })
  const gen = voidGen(fill, opts.void !== false, 64)
  sim.configure(gen, null)
  sim.generate(gen)
  return { sim, logs }
}
/** A stone slab 20 ≤ x,z < 44 at y 20..23, with a spring on top in its middle. */
const island: Fill = (x, y, z) => x >= 20 && x < 44 && z >= 20 && z < 44 ? (y >= 20 && y < 24 ? B.stone : y === 24 && x === 32 && z === 32 ? spring(3) : 0) : 0

const COLLAPSE_BLOCKS: BlockDef[] = [{ name: 'stone' }, { name: 'beam', collapses: true }]
const BEAM = 2
function collapseSim(isVoid: boolean) {
  const sim = new Simulation({ buffers: createWorldBuffers([32, 32, 32]), blocks: COLLAPSE_BLOCKS, seed: 17, randomTicksPerChunk: 0, collapse: {}, log: () => {} })
  const gen = voidGen(() => 0, isVoid, 32)
  sim.configure(gen, null); sim.generate(gen)
  return sim
}
let seq = 0
function settle(sim: Simulation, limit = 400): TickResult[] {
  const results: TickResult[] = []
  for (let i = 0; i < limit; i++) { const r = sim.step(); results.push(r); if (!r.physics.busy) return results }
  throw new Error('did not settle')
}

describe('void world', () => {
  it('reports the void flag', () => {
    expect(voidSim(() => 0).sim.voidWorld).toBe(true)
    expect(voidSim(() => 0, { void: false }).sim.voidWorld).toBe(false)
  })

  it('water running off the island leaves the world; the account balances', () => {
    const { sim, logs } = voidSim(island)
    for (let i = 0; i < 2000; i++) sim.step()
    let below = 0
    for (let z = 0; z < 64; z++) for (let x = 0; x < 64; x++) for (let y = 0; y < 20; y++) if (sim.water.depthAt(x, y, z) > 0) below++
    expect(below).toBe(0)
    expect(logs.filter(l => l.includes('expected'))).toEqual([])
    expect(sim.water.total()).toBe(sim.water.expected)
  }, 60_000)

  it('without void, the same water pools on the floor (unchanged)', () => {
    const { sim } = voidSim(island, { void: false })
    for (let i = 0; i < 2000; i++) sim.step()
    let pooled = 0
    for (let z = 0; z < 64; z++) for (let x = 0; x < 64; x++) if (sim.water.depthAt(x, 0, z) > 0) pooled++
    expect(pooled).toBeGreaterThan(0)
  }, 60_000)

  it('water beside an overhang drains, none collects underneath', () => {
    // The island plus a roof: stone at y 30..31 over 10 ≤ x < 20, with open air below it down to the bottom.
    const roof: Fill = (x, y, z) => island(x, y, z) || (x >= 10 && x < 20 && z >= 20 && z < 44 && (y === 30 || y === 31) ? B.stone : 0)
    const { sim, logs } = voidSim(roof)
    for (let i = 0; i < 3000; i++) sim.step()
    let under = 0
    for (let z = 20; z < 44; z++) for (let x = 10; x < 20; x++) for (let y = 0; y < 30; y++) under += sim.water.depthAt(x, y, z)
    expect(under).toBe(0)
    expect(logs).toEqual([])
  }, 60_000)

  it('a falling block that reaches the bottom is removed', () => {
    const { sim } = voidSim(() => 0)
    sim.submit(0, ++seq, { type: 'setBlock', pos: [5, 10, 5], voxel: B.sand })
    let landed = 0
    for (let i = 0; i < 400; i++) landed += sim.step().landed.length
    expect(landed).toBe(0)
    for (let y = 0; y < 64; y++) expect(sim.store.getVoxel(5, y, 5)).toBe(0)
    expect(sim.gravity.count).toBe(0)
  })

  it('a falling block on the bottom layer falls out too; without void it stays', () => {
    const v = voidSim(() => 0), f = voidSim(() => 0, { void: false })
    for (const { sim } of [v, f]) { sim.submit(0, ++seq, { type: 'setBlock', pos: [5, 0, 5], voxel: B.sand }); for (let i = 0; i < 50; i++) sim.step() }
    expect(v.sim.store.getVoxel(5, 0, 5)).toBe(0)
    expect(f.sim.store.getVoxel(5, 0, 5)).toBe(B.sand)
  })

  it('a fragment cut loose leaves the world and is published as removed', () => {
    const sim = collapseSim(true)
    // A beam on a stone post; the post is the only support.
    sim.submit(0, ++seq, { type: 'fillRegion', min: [5, 0, 5], max: [5, 9, 5], voxel: 1 })
    sim.submit(0, ++seq, { type: 'fillRegion', min: [5, 10, 5], max: [8, 10, 5], voxel: BEAM })
    settle(sim)
    expect(sim.store.getVoxel(8, 10, 5)).toBe(BEAM)
    sim.submit(0, ++seq, { type: 'fillRegion', min: [5, 0, 5], max: [5, 9, 5], voxel: 0 })
    const results = settle(sim)
    const born = results.flatMap(r => r.collapse?.born ?? []), removed = results.flatMap(r => r.collapse?.removed ?? [])
    expect(born).toHaveLength(1)
    expect(removed).toEqual([born[0]!.id])
    expect(results.flatMap(r => r.collapse?.landed ?? [])).toEqual([])
    for (let y = 0; y < 32; y++) for (let x = 5; x <= 8; x++) expect(sim.store.getVoxel(x, y, 5)).toBe(0)
    expect(sim.collapse.stats().fragments).toBe(0)
  })

  it('the world floor is no support for collapse in a void world', () => {
    const v = collapseSim(true), f = collapseSim(false)
    for (const sim of [v, f]) { sim.submit(0, ++seq, { type: 'setBlock', pos: [3, 0, 3], voxel: BEAM }); settle(sim) }
    expect(v.store.getVoxel(3, 0, 3)).toBe(0)
    expect(f.store.getVoxel(3, 0, 3)).toBe(BEAM)
  })
})
