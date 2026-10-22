import { describe, expect, it } from 'vitest'
import { BlockRegistry, defineBlock } from '../src/blocks/registry.ts'
import { KIND, SUB } from '../src/sim/water/constants.ts'
import { waterKinds } from '../src/sim/water/rebuild.ts'
import type { GameSystem, SystemContext } from '../src/sim/systems.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, WATER_BLOCKS, run, settle, w, waterSim, type Fill } from './waterHelpers.ts'

/** A solid block water flows through (an open gate) and a solid wall (a closed one), after the water helper blocks. */
const PASS_BLOCKS = [...WATER_BLOCKS, defineBlock({ name: 'pass', passesWater: true, textures: 'stone' }), defineBlock({ name: 'shut', textures: 'stone' })]
const PASS = 10, SHUT = 11
/** The gap's column: x 5, z 2, cells 1–6. */
const GAP: [number, number] = [5, 2]

/**
 * Two 4 × 4 basins (x 1–4 and x 6–9, z 1–4; walls to y 6) split by a wall at x 5 with a one-column gap at z 2 holding
 * `gap` from y 1 to 6. The left basin holds water 4 blocks deep.
 */
function basins(gap: number): Fill {
  return (x, y, z) => {
    if (y === 0) return B.stone
    if (y <= 6 && x <= 10 && z <= 5) {
      if (x === 0 || x === 10 || z === 0 || z === 5) return B.stone
      if (x === 5) return z === GAP[1] ? gap : B.stone
      if (x <= 4 && y <= 4) return w(7)
    }
    return AIR
  }
}

const sim = (gap: number, o: { debug?: boolean; log?: (m: string) => void; systems?: GameSystem[] } = {}) =>
  waterSim(basins(gap), { blocks: PASS_BLOCKS, water: { debug: o.debug ?? false }, log: o.log, systems: o.systems })

describe('blocks that pass water', () => {
  it('passesWater cannot be combined with liquid', () => {
    expect(() => new BlockRegistry([defineBlock({ name: 'wet', liquid: true, passesWater: true })])).toThrow(/passesWater/)
    const reg = new BlockRegistry(PASS_BLOCKS)
    expect(reg.passesWater[PASS]).toBe(1)
    expect(reg.passesWater[SHUT]).toBe(0)
    expect(waterKinds(reg, B.water)[PASS]).toBe(KIND.PASS)
  })

  it('an open pass cell levels two basins', () => {
    const s = sim(PASS)
    settle(s)
    const left = s.water.column(2, 2).surface, right = s.water.column(7, 2).surface
    expect(right).toBeGreaterThan(SUB)
    expect(Math.abs(left - right)).toBeLessThanOrEqual(SUB / 8)
  })

  it('a shut cell holds', () => {
    const s = sim(SHUT)
    settle(s)
    for (let z = 1; z <= 4; z++) for (let x = 6; x <= 9; x++) expect(s.water.column(x, z).depth).toBe(0)
    expect(s.water.column(2, 2).depth).toBe(4 * SUB)
  })

  it('the mirror never writes a pass cell', () => {
    const s = sim(PASS)
    settle(s)
    expect(s.water.column(...GAP).depth).toBeGreaterThan(SUB)
    for (let y = 1; y <= 6; y++) expect(s.store.getVoxel(GAP[0], y, GAP[1])).toBe(PASS)
    expect(s.store.getVoxel(7, 1, 2) & 0xfff).toBe(B.water) // the water beyond it is mirrored
  })

  it('systems read no water in a pass cell', () => {
    let script: ((c: SystemContext) => void) | null = null
    const sys: GameSystem = { name: 'probe', version: 1, snapshot: () => null, tick: (c) => { const f = script; script = null; f?.(c) } }
    const s = sim(PASS, { systems: [sys] })
    settle(s)
    let got: number[] = []
    script = (c) => { got = [c.waterDepth(5, 1, 2), c.takeWater(5, 1, 2, 64), c.waterDepth(4, 1, 2), c.waterDepth(6, 1, 2)] }
    const before = s.water.total()
    s.step()
    expect(got[0]).toBe(0)
    expect(got[1]).toBe(0)
    expect(got[2]).toBeGreaterThan(0)
    expect(got[3]).toBeGreaterThan(0)
    expect(s.water.total()).toBe(before)
  })

  it('closing a pass cell in water conserves the total', () => {
    const logs: string[] = []
    const s = sim(PASS, { debug: true, log: (m) => logs.push(m) })
    settle(s)
    const before = s.water.total()
    expect(s.water.column(...GAP).depth).toBeGreaterThan(SUB)
    for (let y = 1; y <= 6; y++) s.submit(0, y, { type: 'setBlock', pos: [GAP[0], y, GAP[1]], voxel: SHUT })
    run(s, 200)
    expect(logs.filter((m) => m.includes('check failed'))).toEqual([])
    expect(s.water.check()).toEqual([])
    expect(s.water.total()).toBe(before)
    expect(s.water.column(...GAP).depth).toBe(0)
    for (let y = 1; y <= 6; y++) expect(s.store.getVoxel(GAP[0], y, GAP[1])).toBe(SHUT)
  })
})
