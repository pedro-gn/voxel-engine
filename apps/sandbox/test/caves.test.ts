import { Simulation, createWorldBuffers, SUB, HEAD_EPS, SHOW_MIN } from '@elovox/engine/testing'
import { describe, expect, it } from 'vitest'
import { BLOCKS } from '../src/blocks.ts'
import rules from '../src/rules.ts'
import {
  BRIDGES, CANAL, CAVE, CAVES_SIZE, DAM, LAKE, POND, SHAFT, TUNNEL, VALLEY,
  cavesColumn, cavesGenerator, digTunnelCommands, openCanalCommands, openDamCommands, pierceRoofCommands,
} from '../src/scenes/caves.ts'

function sim(): Simulation {
  const s = new Simulation({ buffers: createWorldBuffers([...CAVES_SIZE]), blocks: BLOCKS, rules, seed: 1, randomTicksPerChunk: 0, log: () => {} })
  s.configure(cavesGenerator, {})
  s.generate(cavesGenerator)
  return s
}

function settle(s: Simulation): void {
  for (let t = 0; t < 3000; t++) if (!s.step().physics.busy) return
  throw new Error('The isolated caves checkpoint did not settle within 3000 ticks')
}

describe('caves scene layout', () => {
  it('has a lake, a dry tunnel closed by a plug, an open shaft, a cave under a shallow pond, a dam over a valley and a bridged canal', () => {
    const lake = cavesColumn(20, 20)
    expect(lake.slice(LAKE.floor, LAKE.top + 1).every((b) => b === 'water')).toBe(true)
    expect(cavesColumn(TUNNEL.x0 + 5, TUNNEL.z0)[TUNNEL.y0]).toBeNull() // dug, dry
    expect(cavesColumn(TUNNEL.plug, TUNNEL.z0)[TUNNEL.y0]).not.toBeNull() // the plug
    expect(cavesColumn(SHAFT.x0, SHAFT.z0).slice(TUNNEL.y0).every((b) => b === null)).toBe(true)
    const pond = cavesColumn(80, 15)
    expect(pond[POND.floor]).toBe('water')
    expect(pond[CAVE.roof]).not.toBeNull()
    expect(pond.slice(CAVE.y0, CAVE.y1 + 1).every((b) => b === null)).toBe(true)
    expect(cavesColumn(30, DAM.z)[LAKE.floor]).not.toBeNull()
    expect(cavesColumn(30, VALLEY.z0)[VALLEY.floor]).toBeNull()
    expect(cavesColumn(CANAL.x0, BRIDGES[1]!.z)[BRIDGES[1]!.deck]).not.toBeNull()
  })
})

describe('caves scene simulation', () => {
  it('the isolated U-tunnel settles with the shaft at lake level and its exact water volume intact', () => {
    const s = sim(), total = s.water.total()
    digTunnelCommands().forEach((c, i) => s.submit(0, i, c))
    settle(s)
    const lake = s.water.column(20, 20).surface, shaft = s.water.column(SHAFT.x0, SHAFT.z0).surface
    expect(shaft).toBeGreaterThan((TUNNEL.y1 + 1) * SUB)
    expect(Math.abs(shaft - lake)).toBeLessThanOrEqual(2 * HEAD_EPS)
    expect(lake).toBeLessThan((LAKE.top + 1) * SUB)
    expect(s.water.total()).toBe(total)
    expect(s.water.check()).toEqual([])
  }, 120_000)

  it('piercing only the roof empties the visible pond into the cave and settles without losing water', () => {
    const s = sim(), total = s.water.total()
    pierceRoofCommands().forEach((c, i) => s.submit(0, i, c))
    settle(s)
    // The opened shaft belongs to the cave: count only water above the pond bed, not its new floor at y 18.
    for (let z = POND.z0; z <= POND.z1; z++) for (let x = POND.x0; x <= POND.x1; x++) {
      expect(Math.max(0, s.water.column(x, z).surface - POND.floor * SUB)).toBeLessThan(SHOW_MIN)
    }
    let cave = 0
    for (let z = CAVE.z0; z <= CAVE.z1; z++) for (let x = CAVE.x0; x <= CAVE.x1; x++) cave += s.water.segments(x, z)[0]!.depth
    expect(cave).toBeGreaterThan(490 * SUB) // the pond started with 512 blocks; only sub-visible films remain above
    expect(s.water.total()).toBe(total)
    expect(s.water.check()).toEqual([])
  }, 120_000)

  it('opening the canal drains through both bridges into the valley, keeping their decks dry and volume exact', () => {
    const s = sim(), total = s.water.total()
    openCanalCommands().forEach((c, i) => s.submit(0, i, c))
    for (let t = 0; t < 1000; t++) s.step()
    for (const bridge of BRIDGES) {
      const segments = s.water.segments(CANAL.x0 + 1, bridge.z), under = segments[0]!
      expect(under.floor).toBe(CANAL.floor)
      expect(under.depth).toBeGreaterThan(SHOW_MIN)
      expect(under.depth).toBeLessThan(Math.min(CANAL.top + 1, bridge.deck) * SUB - CANAL.floor * SUB)
      expect(under.body).toBe(-1) // even the initially full low bridge now has a free surface
      expect(segments[1]!.depth).toBe(0)
      expect(s.store.getVoxel(CANAL.x0 + 1, bridge.deck, bridge.z)).toBe(s.registry.id('stone'))
    }
    expect(s.water.column(90, 101).depth).toBeGreaterThan(0)
    expect(s.water.total()).toBe(total)
    expect(s.water.check()).toEqual([])
  }, 120_000)

  it('reads its lower segments: the cave under the pond, the canal under the low bridge full and grouped', () => {
    const s = sim()
    expect(s.water.segments(80, 15)[0]).toMatchObject({ floor: CAVE.y0, ceil: CAVE.roof, depth: 0 })
    for (let t = 0; t < 3; t++) s.step()
    const under = s.water.segments(CANAL.x0, BRIDGES[1]!.z)[0]!
    expect(under).toMatchObject({ floor: CANAL.floor, ceil: BRIDGES[1]!.deck })
    expect(under.depth).toBe((BRIDGES[1]!.deck - CANAL.floor) * SUB)
    expect(under.body).toBeGreaterThanOrEqual(0)
  }, 120_000)

  it('the hooks: the dam hole drains the lake, the pierced roof fills the cave, the tunnel lifts the shaft', () => {
    const s = sim()
    const total = s.water.total()
    ;[...openDamCommands(), ...pierceRoofCommands(), ...digTunnelCommands()].forEach((c, i) => s.submit(0, i, c))
    for (let t = 0; t < 1500; t++) s.step()
    expect(s.water.total()).toBe(total)
    let cave = 0
    for (let z = CAVE.z0; z <= CAVE.z1; z++) for (let x = CAVE.x0; x <= CAVE.x1; x++) cave += s.water.segments(x, z)[0]!.depth
    expect(cave).toBeGreaterThan(100 * SUB)
    let valley = 0
    for (let z = VALLEY.z0; z <= VALLEY.z0 + 20; z++) for (let x = 20; x <= 40; x++) valley += s.water.column(x, z).depth
    expect(valley).toBeGreaterThan(0)
    expect(s.water.column(SHAFT.x0, SHAFT.z0).surface).toBeGreaterThan((TUNNEL.y1 + 1) * SUB)
  }, 300_000)
})
