import { describe, expect, it } from 'vitest'
import type { Command } from '../src/sim/commands.ts'
import { Pcg32 } from '../src/sim/rng.ts'
import { SUB } from '../src/sim/water/constants.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, fillGenerator, lake, settle, spring, w, waterSim, type Fill } from './waterHelpers.ts'

/** Random ground 1–6 high with water up to y = 4 above it; the low ground reaching the edges is sea (sea level 5). */
function terrain(seed: number): Fill {
  const rng = new Pcg32(seed)
  const h = Array.from({ length: 32 * 32 }, () => 1 + rng.nextInt(6))
  return (x, y, z) => {
    const top = h[x + z * 32]!
    if (y < top) return B.stone
    return y <= 4 ? w(7) : AIR
  }
}

function command(rng: Pcg32): Command | null {
  const k = rng.nextInt(7)
  const x = rng.nextInt(32), y = 1 + rng.nextInt(10), z = rng.nextInt(32)
  switch (k) {
    case 0: return { type: 'setBlock', pos: [x, y, z], voxel: AIR }
    case 1: return { type: 'setBlock', pos: [x, y, z], voxel: B.stone }
    case 2: return { type: 'setBlock', pos: [x, y, z], voxel: w(rng.nextInt(8)) }
    case 3: return { type: 'setBlock', pos: [x, y, z], voxel: B.sand }
    case 4: return { type: 'setBlock', pos: [x, y, z], voxel: spring(rng.nextInt(16)) }
    case 5: return { type: 'fillRegion', min: [x, y, z], max: [Math.min(31, x + 2), y, Math.min(31, z + 2)], voxel: AIR }
    default: return null
  }
}

describe('water conservation', () => {
  it('keeps Σ depth + sea on the running total under random edits, sand and springs, with the debug check quiet', () => {
    for (const seed of [1, 2, 3]) {
      const logs: string[] = []
      const sim = waterSim(terrain(seed), { seed, seaLevel: 5, water: { debug: true }, log: (m) => logs.push(m) })
      const rng = new Pcg32(seed * 977)
      let seq = 0
      for (let t = 0; t < 400; t++) {
        for (let k = 0; k < 3; k++) {
          const c = command(rng)
          if (c) sim.submit(0, seq++, c)
        }
        sim.step()
        expect(sim.water.total()).toBe(sim.water.expected)
      }
      expect(sim.water.check()).toEqual([])
      expect(logs).toEqual([])
      // The same commands replayed from the log reproduce the same world, water included.
      const replay = waterSim(terrain(seed), { seed, seaLevel: 5, water: { debug: true } })
      let i = 0
      for (let t = 0; t < 400; t++) {
        while (i < sim.commandLog.length && sim.commandLog[i]!.tick === t) { const c = sim.commandLog[i++]!; replay.submit(c.clientId, c.seq, c.cmd) }
        replay.step()
      }
      expect(replay.hash()).toBe(sim.hash())
    }
  }, 120_000)
})

describe('the debug check', () => {
  it('logs a failed check and heals by rebuilding from the voxels', () => {
    const logs: string[] = []
    const sim = waterSim(lake(4), { water: { debug: true }, log: (m) => logs.push(m) })
    const before = sim.water.cols.depth.slice()
    sim.water.cols.depth[5 + 5 * 32] += 100 // water from nowhere
    sim.step()
    expect(logs.some((m) => /water: check failed/.test(m))).toBe(true)
    expect(sim.water.needsRebuild).toBe(true)
    sim.step()
    expect(sim.water.needsRebuild).toBe(false)
    expect(sim.water.check()).toEqual([])
    expect(sim.water.column(5, 5).depth).toBe(4 * SUB)
    expect(sim.water.cols.depth).toEqual(before) // the columns are the rebuild of the pre-corruption voxels
  })
})

describe('pause and regenerate', () => {
  it('keeps columns exact through edits and a regeneration while paused, and resumes without a rebuild', () => {
    const logs: string[] = []
    const sim = waterSim(lake(4), { water: { debug: true }, log: (m) => logs.push(m) })
    sim.setPaused(true)
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 7, 5], voxel: w(7) })
    sim.step()
    expect(sim.store.getVoxel(5, 7, 5)).toBe(AIR) // the mirror runs while paused
    expect(sim.water.column(5, 5).depth).toBe(5 * SUB) // nothing flowed: physics is paused
    expect(sim.store.getVoxel(5, 5, 5)).toBe(w(7))
    // Regenerate the chunk column with a shallower lake, still paused.
    const data = new Uint16Array(32 * 32 * 32)
    sim.generateColumnData(fillGenerator(lake(2)), 0, 0, data)
    sim.replaceColumns([{ cx: 0, cz: 0, data }])
    expect(sim.water.column(5, 5)).toMatchObject({ floor: 1, depth: 2 * SUB })
    expect(sim.water.total()).toBe(100 * 2 * SUB)
    expect(sim.water.expected).toBe(sim.water.total())
    sim.setPaused(false)
    settle(sim)
    expect(sim.water.total()).toBe(100 * 2 * SUB)
    expect(sim.water.needsRebuild).toBe(false)
    expect(logs).toEqual([])
  })
})

describe('the world hash', () => {
  it('mixes the water state in, velocities included', () => {
    const a = waterSim(lake(4)), b = waterSim(lake(4))
    expect(a.hash()).toBe(b.hash())
    a.water.cols.flux[2 * (5 + 5 * 32)] = 16
    expect(a.hash()).not.toBe(b.hash())
  })
})

/** Random ground 3–9 high with caves (random air pockets inside it), stone slabs floating over it, and water to y 6. */
function caved(seed: number): Fill {
  const rng = new Pcg32(seed)
  const h = Array.from({ length: 32 * 32 }, () => 3 + rng.nextInt(7))
  const cave = Array.from({ length: 32 * 32 * 12 }, () => rng.nextInt(5) === 0)
  const slab = Array.from({ length: 32 * 32 }, () => (rng.nextInt(6) === 0 ? 8 + rng.nextInt(4) : -1))
  return (x, y, z) => {
    const c = x + z * 32, top = h[c]!
    if (y === 0) return B.stone
    if (y < top) return y < 12 && cave[c * 12 + y] ? (y <= 6 ? w(7) : AIR) : B.stone
    if (y === slab[c]) return B.stone
    return y <= 6 ? w(7) : AIR
  }
}

describe('water conservation in layers', () => {
  it('keeps the total exact and the debug check quiet under random edits on caved terrain, and a replay matches', () => {
    for (const seed of [4, 5, 6]) {
      const logs: string[] = []
      const sim = waterSim(caved(seed), { seed, water: { debug: true }, log: (m) => logs.push(m) })
      const rng = new Pcg32(seed * 131)
      let seq = 0
      for (let t = 0; t < 400; t++) {
        for (let k = 0; k < 3; k++) {
          const c = command(rng)
          if (c) sim.submit(0, seq++, c)
        }
        sim.step()
        expect(sim.water.total()).toBe(sim.water.expected)
      }
      expect(sim.water.check()).toEqual([])
      expect(logs).toEqual([])
      const replay = waterSim(caved(seed), { seed, water: { debug: true } })
      let i = 0
      for (let t = 0; t < 400; t++) {
        while (i < sim.commandLog.length && sim.commandLog[i]!.tick === t) { const c = sim.commandLog[i++]!; replay.submit(c.clientId, c.seq, c.cmd) }
        replay.step()
      }
      expect(replay.hash()).toBe(sim.hash())
    }
  }, 180_000)
})
