import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import { WaterColumns } from '../src/sim/water/columns.ts'
import { SUB } from '../src/sim/water/constants.ts'
import { WaterPublisher, mergeTiles } from '../src/sim/water/publish.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { createWaterBuffers } from '../src/world/waterBuffers.ts'
import { WATER_BLOCKS, fillGenerator, lake, run, w, waterSim } from './waterHelpers.ts'

describe('WaterPublisher', () => {
  it('writes the changed tiles plus the previous publish\'s into alternating parities, stamped', () => {
    const b = createWaterBuffers([32, 32, 32])
    const cols = new WaterColumns(32, 32, new Int16Array(b.floor))
    cols.floor.fill(2)
    cols.depth[0] = 300
    cols.flux[0] = 16 * 5
    cols.flux[1] = -16 * 3
    const p = new WaterPublisher(b)
    const surface = new Int32Array(b.surface), flux = new Int16Array(b.flux), stamp = new Int32Array(b.stamp)
    expect(p.publish([0], cols)).toEqual({ seq: 1, parity: 1, tiles: [0] })
    expect(surface[1024 + 0]).toBe(2 * SUB + 300)
    expect(surface[1024 + 1]).toBe(~(2 * SUB)) // dry: its ground
    expect([flux[2 * 1024], flux[2 * 1024 + 1]]).toEqual([5, -3])
    expect([...stamp]).toEqual([-1, 1])
    expect(p.publish([1], cols)).toEqual({ seq: 2, parity: 0, tiles: [0, 1] })
    expect(p.publish([], cols)).toEqual({ seq: 3, parity: 1, tiles: [1] })
    expect(p.publish([], cols)).toBeNull()
  })

  it('clamps the published flux to 16 bits', () => {
    const b = createWaterBuffers([32, 32, 32])
    const cols = new WaterColumns(32, 32, new Int16Array(b.floor))
    cols.flux[0] = 16 * 40_000
    new WaterPublisher(b).publish([0], cols)
    expect(new Int16Array(b.flux)[2 * 1024]).toBe(32767)
  })

  it('merges sorted tile lists without duplicates', () => {
    expect(mergeTiles([1, 4, 9], [0, 4, 10])).toEqual([0, 1, 4, 9, 10])
    expect(mergeTiles([], [])).toEqual([])
  })

  it('merges with an empty side without allocating: the other side comes back as is', () => {
    const a = [2, 5]
    expect(mergeTiles(a, [])).toBe(a)
    expect(mergeTiles([], a)).toBe(a)
  })

  it('leaves both parities holding the latest value of a tile changed on consecutive publishes', () => {
    const b = createWaterBuffers([32, 32, 32])
    const cols = new WaterColumns(32, 32, new Int16Array(b.floor))
    cols.floor.fill(0)
    const p = new WaterPublisher(b)
    const surface = new Int32Array(b.surface)
    cols.depth[0] = 100 // A
    p.publish([0], cols)
    cols.depth[0] = 200 // B
    p.publish([0], cols)
    expect(p.publish([], cols)).toEqual({ seq: 3, parity: 1, tiles: [0] })
    expect([surface[0], surface[1024]]).toEqual([200, 200])
  })

  it('publishes nothing on a tick that leaves a rebuild pending, and every dirty tile on the next', () => {
    const sim = waterSim(lake(4), { water: { debug: true } })
    run(sim, 3) // the generation's publishes are out
    expect(sim.step().water).toBeNull()
    sim.water.cols.depth[5 + 5 * 32] += 100 // water from nowhere: the check fails and a rebuild is pending
    expect(sim.step().water).toBeNull()
    expect(sim.water.needsRebuild).toBe(true)
    expect(sim.step().water!.tiles).toEqual([0, 1, 2, 3])
  })

  it('publishes from the Simulation: every tile after generation, twice, then an edit\'s tiles, and nothing once quiet', () => {
    const buffers = createWorldBuffers([32, 32, 32])
    const sim = new Simulation({ buffers, blocks: WATER_BLOCKS, seed: 1, log: () => {} })
    sim.generate(fillGenerator(lake(4)))
    const t1 = sim.step().water!
    expect(t1.tiles).toEqual([0, 1, 2, 3])
    const surface = new Int32Array(buffers.water.surface)
    expect(surface[t1.parity * 1024 + 5 + 5 * 32]).toBe(5 * SUB)
    expect(surface[t1.parity * 1024 + 20 + 20 * 32]).toBe(~SUB)
    expect(sim.step().water!.tiles).toEqual([0, 1, 2, 3]) // once more, so the other parity is complete too
    expect(sim.step().water).toBeNull()
    sim.submit(0, 0, { type: 'setBlock', pos: [5, 7, 5], voxel: w(7) })
    expect(sim.step().water!.tiles).toContain(0)
  })
})
