import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import { TILE } from '../src/sim/water/constants.ts'
import { RECORD } from '../src/sim/water/links.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, WATER_BLOCKS, fillGenerator, w, type Fill } from './waterHelpers.ts'

/** The hash of every publish of the world below over TICKS ticks, recorded on the code before 4a round 2 #5. */
const GOLDEN = 1262533496
const TICKS = 160
const SIZE: [number, number, number] = [64, 32, 32]

/**
 * x < 32: a lake (x 1–10, z 1–10, water y 10–15) over a dry cave (y 2–7), beside a valley (x 12–30, z 1–10, air y 2–20) with a
 * deck at y 14 over x 14–22; stone to y 20 elsewhere.
 * x ≥ 32: five 2-high caves stacked at y 2, 5, 8, 11, 14 under x 34–45, z 3–12, each holding one block of water (ranks 1–5:
 * 4 and 5 are hidden), and a sealed chamber full of water (x 50–55, z 20–25, y 2–5); stone to y 20 elsewhere.
 */
const world: Fill = (x, y, z) => {
  if (y === 0) return B.stone
  if (x < 32) {
    if (x >= 1 && x <= 10 && z >= 1 && z <= 10) {
      if (y >= 2 && y <= 7) return AIR
      if (y <= 9) return B.stone
      return y <= 15 ? w(7) : AIR
    }
    if (x >= 12 && x <= 30 && z >= 1 && z <= 10 && y >= 2 && y <= 20) return x >= 14 && x <= 22 && y === 14 ? B.stone : AIR
    return y <= 20 ? B.stone : AIR
  }
  if (x >= 34 && x <= 45 && z >= 3 && z <= 12 && y >= 2 && y <= 16) {
    const k = (y - 2) % 3
    return k === 0 ? w(7) : k === 1 ? AIR : B.stone
  }
  if (x >= 50 && x <= 55 && z >= 20 && z <= 25 && y >= 2 && y <= 5) return w(7)
  return y <= 20 ? B.stone : AIR
}

/** Edits by tick: the dam hole and the cave's roof hole, then a shaft beside the stack, then a pit that opens the chamber. */
const EDITS: Record<number, { min: [number, number, number]; max: [number, number, number] }[]> = {
  0: [{ min: [11, 10, 5], max: [11, 11, 6] }, { min: [5, 8, 5], max: [5, 9, 5] }],
  30: [{ min: [46, 2, 7], max: [46, 16, 7] }],
  60: [{ min: [56, 1, 20], max: [60, 5, 25] }],
}

describe('water publish golden (4a round 2 #5)', () => {
  it('publishes exactly what the code before #5 published, tick by tick', () => {
    const buffers = createWorldBuffers(SIZE)
    const sim = new Simulation({ buffers, blocks: WATER_BLOCKS, seed: 1, log: () => {}, randomTicksPerChunk: 0 })
    const gen = fillGenerator(world)
    sim.configure(gen, null)
    sim.generate(gen)
    const n = SIZE[0] * SIZE[2], tx = SIZE[0] / TILE
    const surface = new Int32Array(buffers.water.surface), flux = new Int16Array(buffers.water.flux)
    let h = 0x811c9dc5
    const mix = (v: number) => { h = Math.imul(h ^ (v | 0), 0x01000193) >>> 0 }
    let seq = 0, rank0 = 0, lower = 0, maxHidden = 0
    for (let tick = 0; tick < TICKS; tick++) {
      for (const e of EDITS[tick] ?? []) sim.submit(0, ++seq, { type: 'fillRegion', min: e.min, max: e.max, voxel: AIR })
      const t = sim.step().water
      const hidden = sim.water.stats().layersHidden
      mix(tick); mix(hidden); maxHidden = Math.max(maxHidden, hidden)
      if (!t) { mix(-2); continue }
      mix(t.seq); mix(t.parity); mix(t.tiles.length)
      const base = t.parity * n
      for (const tile of t.tiles) {
        mix(tile)
        const x0 = (tile % tx) * TILE, z0 = Math.floor(tile / tx) * TILE
        for (let z = z0; z < z0 + TILE; z++) for (let x = x0; x < x0 + TILE; x++) {
          const c = base + x + z * SIZE[0]
          mix(surface[c]!); mix(flux[2 * c]!); mix(flux[2 * c + 1]!)
        }
      }
      if (!t.layers) { mix(-1); continue }
      mix(t.layers.length)
      for (const v of t.layers) mix(v)
      // Coverage: walk the records (per tile: tile, count, then count × RECORD ints) and count ranks.
      for (let i = 0; i < t.layers.length;) {
        const count = t.layers[i + 1]!
        for (let r = 0; r < count; r++) {
          const rank = t.layers[i + 2 + r * RECORD]! >> 8
          if (rank === 0) rank0++
          else lower++
        }
        i += 2 + count * RECORD
      }
    }
    // The world must exercise what the hash pins: top records, lower records and hidden segments.
    expect([rank0 > 0, lower > 0, maxHidden > 0]).toEqual([true, true, true])
    expect(h).toBe(GOLDEN)
  }, 60_000)
})
