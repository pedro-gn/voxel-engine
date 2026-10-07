import { describe, expect, it } from 'vitest'
import { BlockRegistry, type BlockDef } from '../src/blocks/registry.ts'
import { Simulation, type TickResult } from '../src/sim/simulation.ts'
import type { CollapseOptions } from '../src/sim/collapse.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { AIR, packVoxel } from '../src/world/voxel.ts'

const blocks: BlockDef[] = [{ name: 'stone' }, { name: 'beam', collapses: true }, { name: 'sand', falls: true }, { name: 'water', liquid: true }]
function setup(collapse?: CollapseOptions) {
  const sim = new Simulation({ buffers: createWorldBuffers([64, 32, 32]), blocks, seed: 17, randomTicksPerChunk: 0, collapse })
  sim.generate({ generateColumn(ctx) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) ctx.set(x, 0, z, 1) } })
  return sim
}
let seq = 0
function set(sim: Simulation, x: number, y: number, z: number, voxel: number) { sim.submit(0, seq++, { type: 'setBlock', pos: [x, y, z], voxel }) }
function fill(sim: Simulation, min: [number, number, number], max: [number, number, number], voxel: number) { sim.submit(0, seq++, { type: 'fillRegion', min, max, voxel }) }
function settle(sim: Simulation, limit = 400): TickResult[] {
  const results: TickResult[] = []
  for (let i = 0; i < limit; i++) { const r = sim.step(); results.push(r); if (!r.physics.busy) return results }
  throw new Error(`did not settle: ${JSON.stringify(sim.collapse.stats())}`)
}
function count(sim: Simulation, id: number) {
  let n = 0
  for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) for (let x = 0; x < 64; x++) if ((sim.store.getVoxel(x, y, z) & 0xfff) === id) n++
  return n
}

describe('opt-in structural collapse', () => {
  it('leaves normal blocks unchanged and keeps sand on individual gravity', () => {
    const sim = setup()
    set(sim, 8, 15, 8, 1); set(sim, 12, 15, 8, 3)
    settle(sim)
    expect(sim.store.getVoxel(8, 15, 8)).toBe(1)
    expect(sim.store.getVoxel(12, 1, 8)).toBe(3)
    expect(sim.collapse.stats().fragments).toBe(0)
  })
  it('rejects incompatible collapse flags and derives support separately from visual layer', () => {
    const registry = new BlockRegistry([{ name: 'glass', layer: 'translucent' }, { name: 'beam', collapses: true }, { name: 'sand', falls: true }])
    expect([...registry.structural]).toEqual([0, 2, 1, 0])
    for (const extra of [{ falls: true }, { liquid: true }, { solid: false }, { liquid: true, source: 'water' }]) {
      expect(() => new BlockRegistry([{ name: 'bad', collapses: true, ...extra }])).toThrow(/collapses/)
    }
  })
  it('holds a beam by either support and drops the connected shape when both are removed', () => {
    const sim = setup()
    fill(sim, [10, 1, 8], [10, 10, 8], 1); fill(sim, [18, 1, 8], [18, 10, 8], 1)
    fill(sim, [10, 11, 8], [18, 11, 8], packVoxel(2, 6))
    settle(sim)
    set(sim, 10, 10, 8, AIR); settle(sim)
    expect(sim.store.getVoxel(14, 11, 8)).toBe(packVoxel(2, 6))
    set(sim, 18, 10, 8, AIR)
    const results = settle(sim)
    const births = results.flatMap(r => r.collapse?.born ?? [])
    expect(births).toHaveLength(1)
    expect(births[0].positions).toHaveLength(9)
    expect(new Set(births[0].voxels)).toEqual(new Set([packVoxel(2, 6)]))
    expect(count(sim, 2)).toBe(9)
    for (let x = 10; x <= 18; x++) expect(sim.store.getVoxel(x, 10, 8)).toBe(packVoxel(2, 6))
  })
  it('does not treat diagonal contact as support, but uses the world floor', () => {
    const sim = setup()
    set(sim, 10, 10, 10, 2); set(sim, 11, 11, 10, 1); set(sim, 20, 0, 20, 2)
    settle(sim)
    expect(sim.store.getVoxel(10, 1, 10)).toBe(2)
    expect(sim.store.getVoxel(11, 11, 10)).toBe(1)
    expect(sim.store.getVoxel(20, 0, 20)).toBe(2)
  })
  it('finds alternate support across chunk boundaries and has no radius approximation', () => {
    const sim = setup({ scanCap: 8, mutationCap: 16, fragmentCells: 16 })
    fill(sim, [3, 20, 10], [59, 20, 10], 2); set(sim, 60, 20, 10, 1)
    const rs = settle(sim)
    expect(rs.flatMap(r => r.collapse?.born ?? [])).toEqual([])
    expect(count(sim, 2)).toBe(57)
    expect(rs.every(r => r.physics.collapse!.visited <= 8)).toBe(true)
    set(sim, 60, 20, 10, AIR)
    const fallen = settle(sim)
    expect(count(sim, 2)).toBe(57)
    expect(fallen.every(r => r.physics.collapse!.visited <= 8 && r.physics.collapse!.mutations <= 16)).toBe(true)
  })
  it('rechecks a new support added during a partial search', () => {
    const sim = setup({ scanCap: 4, mutationCap: 4, fragmentCells: 4 })
    fill(sim, [10, 20, 10], [29, 20, 10], 2)
    sim.step(); sim.step()
    set(sim, 30, 20, 10, 1)
    const rs = settle(sim)
    expect(rs.flatMap(r => r.collapse?.born ?? [])).toEqual([])
    expect(count(sim, 2)).toBe(20)
  })
  it('keeps capacity-limited fragments pending without loss and eventually reaches idle', () => {
    const sim = setup({ scanCap: 32, mutationCap: 4, fragmentCells: 4, maxFragments: 1 })
    fill(sim, [10, 25, 10], [29, 25, 10], 2)
    const rs = settle(sim, 1000)
    expect(count(sim, 2)).toBe(20)
    expect(rs.every(r => r.physics.collapse!.fragments <= 1 && r.physics.collapse!.mutations <= 4)).toBe(true)
    expect(sim.collapse.busy).toBe(false)
    const idle = sim.step()
    expect(idle.physics.collapse!.visited).toBe(0)
    expect(idle.collapse).toBeUndefined()
  })
  it('partitions a thick component from its base so pieces do not repeatedly land on pending cells', () => {
    const sim = setup({ scanCap: 128, mutationCap: 16, fragmentCells: 16, maxFragments: 4 })
    fill(sim, [10, 20, 10], [21, 23, 21], 2)
    const rs = settle(sim, 2000)
    expect(count(sim, 2)).toBe(576)
    expect(rs.at(-1)!.physics.collapse!.fragments).toBe(0)
  })
  it('pauses detection and moving fragments; birth membership is published once', () => {
    const sim = setup()
    sim.setPaused(true); set(sim, 10, 20, 10, 2)
    expect(sim.step().collapse).toBeUndefined()
    expect(sim.store.getVoxel(10, 20, 10)).toBe(2)
    sim.setPaused(false)
    const born = sim.step().collapse!
    expect(born.born).toHaveLength(1)
    sim.setPaused(true)
    for (let i = 0; i < 4; i++) {
      const paused = sim.step().collapse!
      expect(paused.born).toEqual([])
      expect(paused.poses).toEqual(born.poses)
    }
    sim.setPaused(false); settle(sim)
    expect(sim.store.getVoxel(10, 1, 10)).toBe(2)
  })
  it('rejects overlapping placements and entire fills without partial writes', () => {
    const sim = setup(); set(sim, 10, 20, 10, 2); sim.step()
    set(sim, 10, 20, 10, 1); fill(sim, [9, 19, 10], [11, 20, 10], 1)
    const r = sim.step()
    expect(r.acks.every(a => !a.ok && a.error?.includes('overlaps'))).toBe(true)
    expect(sim.store.getVoxel(9, 19, 10)).toBe(AIR)
    expect(() => sim.replaceColumns([{ cx: 0, cz: 0, data: new Uint16Array(32768) }])).toThrow(/regeneration overlaps/)
  })
  it('hits an obstacle inside an arch, using every exposed downward run', () => {
    const sim = setup()
    fill(sim, [10, 18, 10], [10, 20, 10], 2); fill(sim, [14, 18, 10], [14, 20, 10], 2)
    fill(sim, [11, 20, 10], [13, 20, 10], 2); set(sim, 12, 10, 10, 1)
    settle(sim)
    expect(count(sim, 2)).toBe(9)
    expect(sim.store.getVoxel(12, 11, 10)).toBe(2)
    expect(sim.store.getVoxel(10, 9, 10)).toBe(2)
  })
  it('replays grid, pending checks and fragment motion deterministically', () => {
    const a = setup({ scanCap: 8, mutationCap: 8, fragmentCells: 8 }), b = setup({ scanCap: 8, mutationCap: 8, fragmentCells: 8 })
    for (const sim of [a, b]) fill(sim, [10, 20, 10], [26, 20, 10], 2)
    for (let tick = 0; tick < 120; tick++) { a.step(); b.step(); expect(a.hash()).toBe(b.hash()) }
  })
  it('handles multiple runs in the same column and an obstacle inside the gap', () => {
    const sim = setup()
    fill(sim, [10, 15, 10], [14, 15, 10], 2); fill(sim, [10, 20, 10], [14, 20, 10], 2)
    fill(sim, [10, 16, 10], [10, 19, 10], 2); fill(sim, [14, 16, 10], [14, 19, 10], 2)
    set(sim, 12, 17, 10, 1)
    settle(sim)
    expect(count(sim, 2)).toBe(18)
    expect(sim.store.getVoxel(12, 18, 10)).toBe(2)
    expect(sim.store.getVoxel(12, 13, 10)).toBe(2)
  })
  it('keeps ordinary falling sand above a moving fragment without passing through it', () => {
    const sim = setup()
    set(sim, 10, 15, 10, 2); set(sim, 10, 25, 10, 3)
    settle(sim)
    expect(count(sim, 2)).toBe(1); expect(count(sim, 3)).toBe(1)
    expect(sim.store.getVoxel(10, 1, 10)).toBe(2); expect(sim.store.getVoxel(10, 2, 10)).toBe(3)
  })
  it('bulk generation seeds isolated structural blocks; normal generations do no structural visits', () => {
    const sim = setup()
    const column = new Uint16Array(32768)
    for (let i = 0; i < 1024; i++) column[i] = 1
    column[5 + (5 << 5) + (12 << 10)] = 2
    sim.replaceColumns([{ cx: 0, cz: 0, data: column }])
    settle(sim)
    expect(sim.store.getVoxel(5, 1, 5)).toBe(2)
    expect(setup().step().physics.collapse!.visited).toBe(0)
  })
  it('preserves the lake volume while reinserting a multi-cell fragment', () => {
    const sim = setup()
    for (let y = 1; y <= 5; y++) {
      fill(sim, [4, y, 4], [11, y, 4], 1); fill(sim, [4, y, 11], [11, y, 11], 1)
      fill(sim, [4, y, 5], [4, y, 10], 1); fill(sim, [11, y, 5], [11, y, 10], 1)
    }
    fill(sim, [5, 1, 5], [10, 3, 10], packVoxel(4, 7)); sim.step()
    const volume = sim.water.total()
    fill(sim, [6, 12, 6], [8, 12, 6], 2)
    for (let i = 0; i < 100; i++) { sim.step(); expect(sim.water.total()).toBe(volume) }
    expect(sim.store.getVoxel(7, 1, 6)).toBe(2)
    expect(sim.water.check()).toEqual([])
  })
  it('matches a full connectivity oracle on small randomized mixed structures', () => {
    let rng = 7123
    const random = () => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng / 0x100000000 }
    for (let trial = 0; trial < 20; trial++) {
      const sim = setup(), roles = new Map<number, number>()
      sim.setPaused(true)
      for (let y = 20; y < 24; y++) for (let z = 5; z < 11; z++) for (let x = 5; x < 11; x++) {
        const n = random(), id = n < .13 ? 1 : n < .55 ? 2 : 0
        if (id) { set(sim, x, y, z, id); roles.set(sim.layout.voxelIndex(x, y, z), id) }
      }
      sim.step()
      const visited = new Set<number>(), unsupported = new Set<number>()
      for (const [seed, role] of roles) {
        if (role !== 2 || visited.has(seed)) continue
        const group = [seed]; visited.add(seed); let supported = false
        for (let head = 0; head < group.length; head++) {
          const [x, y, z] = sim.layout.voxelCoords(group[head])
          for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
            const p = sim.layout.voxelIndex(x + dx, y + dy, z + dz), value = roles.get(p)
            if (value === 1) supported = true
            if (value === 2 && !visited.has(p)) { group.push(p); visited.add(p) }
          }
        }
        if (!supported) for (const p of group) unsupported.add(p)
      }
      sim.setPaused(false)
      const born = sim.step().collapse?.born ?? []
      expect(new Set(born.flatMap(b => [...b.positions]))).toEqual(unsupported)
    }
  })
})
