import { describe, expect, it } from 'vitest'
import { defineGenerator, type GeneratorModule } from '../src/sim/generator.ts'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'

const SIZE = [128, 64, 96] as const // 4 × 3 chunk columns, 2 chunks high

/** Flat stone; a column listed in `raised` ("cx,cz") gets its own height. */
function ground(level: number, raised: Record<string, number> = {}): GeneratorModule {
  return defineGenerator({
    generateColumn(ctx, cx, cz) {
      const l = raised[`${cx},${cz}`] ?? level
      for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) for (let y = 0; y < l; y++) ctx.set(lx, y, lz, ID.stone)
    },
  })
}

/** Ground at 20 with a stone roof over x 40..69 and a torch under it; variant b moves both and digs a pit. */
function scene(variant: 'a' | 'b'): GeneratorModule {
  return defineGenerator({
    generateColumn(ctx, cx, cz) {
      for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
        const x = cx * 32 + lx, z = cz * 32 + lz
        const floor = variant === 'b' && x > 44 && x < 52 && z > 8 && z < 20 ? 12 : 20
        for (let y = 0; y < floor; y++) ctx.set(lx, y, lz, ID.stone)
        const roof = variant === 'a' ? x >= 40 && x < 70 : x >= 34 && x < 50 && z < 40
        if (roof && z < 50) ctx.set(lx, 30, lz, ID.stone)
        if (variant === 'a' && x === 50 && z === 10) ctx.set(lx, 21, lz, ID.torch)
        if (variant === 'b' && x === 40 && z === 20) ctx.set(lx, 21, lz, ID.torch)
      }
    },
  })
}

/** Column (1, 0) from b, the rest from a. */
const mixed = defineGenerator({
  generateColumn(ctx, cx, cz) { (cx === 1 && cz === 0 ? scene('b') : scene('a')).generateColumn(ctx, cx, cz) },
})

function world(gen: GeneratorModule, regenLightDiffLimit?: number): Simulation {
  const sim = new Simulation({ buffers: createWorldBuffers([...SIZE]), blocks: TEST_BLOCKS, seed: 1, regenLightDiffLimit })
  sim.generate(gen)
  return sim
}
function column(sim: Simulation, gen: GeneratorModule, cx: number, cz: number) {
  const data = new Uint16Array(32 * 32 * SIZE[1])
  sim.generateColumnData(gen, cx, cz, data)
  return { cx, cz, data }
}
function differences(a: Simulation, b: Simulation): number {
  let n = 0
  for (let y = 0; y < SIZE[1]; y++) for (let z = 0; z < SIZE[2]; z++) for (let x = 0; x < SIZE[0]; x++) {
    if (a.store.getVoxel(x, y, z) !== b.store.getVoxel(x, y, z) || a.store.getLight(x, y, z) !== b.store.getLight(x, y, z)) n++
  }
  return n
}
/** Every chunk whose voxels or light differ between two worlds. */
function changedChunks(a: Simulation, b: Simulation): number[] {
  const out = new Set<number>()
  for (let y = 0; y < SIZE[1]; y++) for (let z = 0; z < SIZE[2]; z++) for (let x = 0; x < SIZE[0]; x++) {
    if (a.store.getVoxel(x, y, z) !== b.store.getVoxel(x, y, z) || a.store.getLight(x, y, z) !== b.store.getLight(x, y, z)) out.add(a.layout.chunkOf(x, y, z))
  }
  return [...out]
}

describe('Simulation.replaceColumns', () => {
  it('writes nothing and remeshes nothing when the columns are unchanged', () => {
    const gen = ground(20)
    const sim = world(gen)
    const versions = Array.from(sim.store.versions)
    expect(sim.replaceColumns([column(sim, gen, 1, 0), column(sim, gen, 2, 1)])).toEqual([])
    expect(Array.from(sim.store.versions)).toEqual(versions)
  })

  it('remeshes the changed chunk and only the neighbours that see its changed borders', () => {
    const sim = world(ground(20))
    const dirty = sim.replaceColumns([column(sim, ground(20, { '1,0': 30 }), 1, 0)])
    const L = sim.layout
    // Ground 20 → 30 stays inside chunk row cy 0 and reaches its ±x and ±z borders (z = 0 is the world edge).
    const expected = [[1, 0], [0, 0], [2, 0], [0, 1], [1, 1], [2, 1]].map(([cx, cz]) => L.chunkIndex(cx!, 0, cz!))
    expect(dirty).toEqual(expected.sort((a, b) => a - b))
  })

  it('leaves the same voxels and light as generating the changed world from scratch', () => {
    const sim = world(scene('a'))
    sim.replaceColumns([column(sim, scene('b'), 1, 0)])
    expect(differences(sim, world(mixed))).toBe(0)
  })

  it('remeshes every chunk whose voxels or light changed, even outside the replaced columns', () => {
    const before = world(scene('a'))
    const sim = world(scene('a'))
    const dirty = sim.replaceColumns([column(sim, scene('b'), 1, 0)])
    const changed = changedChunks(before, sim)
    expect(changed.some((ci) => sim.layout.chunkCoords(ci)[0] === 0)).toBe(true) // torch light crossed into column 0
    for (const ci of changed) expect(dirty).toContain(ci)
  })

  it('falls back to every relit chunk above the light diff limit, with the same world', () => {
    const sim = world(scene('a'), 0)
    const dirty = sim.replaceColumns([column(sim, scene('b'), 1, 0)])
    expect(differences(sim, world(mixed))).toBe(0)
    for (const ci of changedChunks(world(scene('a')), sim)) expect(dirty).toContain(ci)
  })
})
