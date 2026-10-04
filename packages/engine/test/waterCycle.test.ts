import { describe, expect, it } from 'vitest'
import { WaterColumns } from '../src/sim/water/columns.ts'
import { SPRING_RATES, SPRING_SCALE, SUB } from '../src/sim/water/constants.ts'
import { WaterCycle } from '../src/sim/water/cycle.ts'
import { Layout } from '../src/world/layout.ts'
import { AIR, packVoxel } from '../src/world/voxel.ts'

const CAP = 1 << 20
const SPRING_ID = 9
const source = new Uint8Array(16)
source[SPRING_ID] = 1

function grid(sx: number, sz: number, floor: (x: number, z: number) => number, depth: (x: number, z: number) => number): WaterColumns {
  const g = new WaterColumns(sx, sz, new Int16Array(sx * sz))
  for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
    g.floor[x + z * sx] = floor(x, z)
    g.depth[x + z * sx] = depth(x, z)
  }
  return g
}

describe('sea columns', () => {
  it('marks wet columns at sea level that reach the world edge, and nothing else', () => {
    // Sea for z ≥ 20; an inland lake at the same surface; a puddle at the corner above sea level.
    const g = grid(32, 32,
      (x, z) => (z >= 20 ? 2 : x >= 5 && x <= 8 && z >= 5 && z <= 8 ? 3 : 10),
      (x, z) => (z >= 20 ? 3 * SUB : x >= 5 && x <= 8 && z >= 5 && z <= 8 ? 2 * SUB : x === 0 && z === 0 ? 7 : 0))
    const cy = new WaterCycle(g.n)
    cy.seaLevel = 5
    cy.findSea(g)
    expect(cy.mask[10 + 25 * 32]).toBe(1)
    expect(cy.mask[6 + 6 * 32]).toBe(0) // same surface, but landlocked
    expect(cy.mask[0]).toBe(0)
    expect(cy.seaDepth(g)).toBe(12 * 32 * 3 * SUB)
  })

  it('pins the sea at its level and keeps Σ depth + sea constant while land water pours in', () => {
    const g = grid(32, 32, (_x, z) => (z >= 24 ? 0 : 6), (x, z) => (z >= 24 ? 5 * SUB : x >= 2 && x <= 10 && z >= 2 && z <= 10 ? 2 * SUB : 0))
    for (let t = 0; t < g.tiles.count; t++) g.tiles.wake(t)
    const cy = new WaterCycle(g.n)
    cy.seaLevel = 5
    cy.findSea(g)
    cy.sea = cy.seaDepth(g)
    const sea0 = cy.sea, v0 = g.total() + cy.sea
    for (let i = 0; i < 1500; i++) {
      cy.sea += g.step(CAP, cy.mask, 5 * SUB)
      expect(g.total() + cy.sea).toBe(v0)
    }
    for (let x = 0; x < 32; x++) expect(g.surface(x + 28 * 32)).toBe(5 * SUB)
    expect(cy.sea).toBeGreaterThan(sea0) // land water reached the sea
  })
})

describe('springs', () => {
  const layout = new Layout([32, 32, 32])
  const at = (y: number, v: number) => (x: number, yy: number, z: number) => (x === 5 && yy === y && z === 5 ? v : AIR)

  it('adds its rate to its column from the sea, wakes its tile, and stops when the sea is empty', () => {
    const g = grid(32, 32, () => 4, () => 0)
    const cy = new WaterCycle(g.n)
    cy.seaLevel = 5
    cy.sea = 40
    cy.springs.add(layout.voxelIndex(5, 3, 5))
    const get = at(3, packVoxel(SPRING_ID, 0)) // rate 1 × 16 per step
    const rate = SPRING_RATES[0]! * SPRING_SCALE
    cy.runSprings(g, layout, get, source)
    expect([g.depth[5 + 5 * 32], cy.sea]).toEqual([rate, 40 - rate])
    expect(g.tiles.awake[0]).toBe(1)
    cy.runSprings(g, layout, get, source)
    cy.runSprings(g, layout, get, source)
    cy.runSprings(g, layout, get, source)
    expect([g.depth[5 + 5 * 32], cy.sea]).toEqual([40, 0])
  })

  it('is unbounded without a sea level: the account goes negative and the identity holds', () => {
    const g = grid(32, 32, () => 4, () => 0)
    const cy = new WaterCycle(g.n)
    cy.springs.add(layout.voxelIndex(5, 3, 5))
    for (let i = 0; i < 3; i++) cy.runSprings(g, layout, at(3, packVoxel(SPRING_ID, 4)), source)
    expect(g.depth[5 + 5 * 32]).toBe(3 * SPRING_RATES[4]! * SPRING_SCALE)
    expect(g.total() + cy.sea).toBe(0)
  })

  it('gives nothing when buried (its column\'s floor is not on it), and forgets a spring that is gone', () => {
    const g = grid(32, 32, () => 9, () => 0) // floor 9: something sits on the spring at y = 3
    const cy = new WaterCycle(g.n)
    cy.springs.add(layout.voxelIndex(5, 3, 5))
    cy.runSprings(g, layout, at(3, packVoxel(SPRING_ID, 4)), source)
    expect(g.total()).toBe(0)
    expect(cy.springs.size).toBe(1)
    cy.runSprings(g, layout, () => AIR, source)
    expect(cy.springs.size).toBe(0)
  })
})
