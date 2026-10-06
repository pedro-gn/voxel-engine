import { Simulation } from '@elovox/engine/src/sim/simulation.ts'
import { createWorldBuffers } from '@elovox/engine/src/world/buffers.ts'
import { SUB } from '@elovox/engine/src/world/waterBuffers.ts'
import { describe, expect, it } from 'vitest'
import { BLOCKS } from '../src/blocks.ts'
import rules from '../src/rules.ts'
import {
  BRIDGES, CANAL, CAVE, CAVES_SIZE, DAM, LAKE, POND, SHAFT, TUNNEL, VALLEY,
  cavesColumn, cavesGenerator, digTunnelCommands, openDamCommands, pierceRoofCommands,
} from '../src/scenes/caves.ts'

function sim(): Simulation {
  const s = new Simulation({ buffers: createWorldBuffers([...CAVES_SIZE]), blocks: BLOCKS, rules, seed: 1, randomTicksPerChunk: 0, log: () => {} })
  s.configure(cavesGenerator, {})
  s.generate(cavesGenerator)
  return s
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
