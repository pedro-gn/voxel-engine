import { describe, expect, it } from 'vitest'
import { BlockRegistry } from '../src/blocks/registry.ts'
import { LADDER_COST, NavigationSystem } from '../src/sim/navigation/navigation.ts'
import { RegionStore } from '../src/sim/navigation/regions.ts'
import { RouteSearch } from '../src/sim/navigation/routeSearch.ts'
import { Layout } from '../src/world/layout.ts'
import { testRegistry } from './helpers.ts'
import { routeChecksum } from './routeChecksum.ts'

describe('a world without climbable blocks', () => {
  it('keeps four directions', () => {
    const layout = new Layout([32, 32, 32])
    expect(new NavigationSystem({ layout, registry: testRegistry(), get: () => 0 }).dirs).toBe(4)
  })
  it('gives the routeFuzz worlds the routes they had on 5845093, node for node', { timeout: 300_000 }, () => {
    expect(routeChecksum()).toBe(4292988158)
  })
})

const STONE = 1, LADDER = 2
/**
 * 32³: a stone floor (y ≤ 3), a stone wall at x = 5 (y 4..9, every z), ladder cells at (4, 4..9, 5) against it, and the
 * optional ledge (stone at (3, 6, 5)).
 */
function fixture(ledge = false) {
  const layout = new Layout([32, 32, 32]), registry = new BlockRegistry([{ name: 'stone' }, { name: 'ladder', solid: false, climbable: true }])
  const cells = new Uint8Array(layout.voxelCount)
  for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) {
    for (let y = 0; y <= 3; y++) cells[layout.voxelIndex(x, y, z)] = STONE
    for (let y = 4; y <= 9; y++) if (x === 5) cells[layout.voxelIndex(x, y, z)] = STONE
  }
  for (let y = 4; y <= 9; y++) cells[layout.voxelIndex(4, y, 5)] = LADDER
  if (ledge) cells[layout.voxelIndex(3, 6, 5)] = STONE
  const nav = new NavigationSystem({ layout, registry, get: (x, y, z) => layout.inBounds(x, y, z) ? cells[layout.voxelIndex(x, y, z)]! : 0 })
  const at = (x: number, y: number, z: number) => layout.voxelIndex(x, y, z)
  return { layout, nav, cells, at }
}
function flat(nav: NavigationSystem, a: number, b: number) {
  const s = nav.request(a, [b])
  while (s.status === 'pending') nav.step(1 << 20)
  return s.result()
}

describe('ladders in navigation', () => {
  it('uses six directions and stands on a rung with no floor', () => {
    const { nav } = fixture()
    expect(nav.dirs).toBe(6)
    expect(nav.stand(4, 7, 5)).toBe(true)
    expect(nav.stand(3, 7, 5)).toBe(false)
  })
  it('joins rungs up and down at the ladder cost', () => {
    const { nav, at } = fixture()
    expect(nav.neighbor(at(4, 7, 5), 4)).toBe(at(4, 8, 5))
    expect(nav.neighbor(at(4, 7, 5), 5)).toBe(at(4, 6, 5))
    expect(nav.neighbor(at(4, 9, 5), 4)).toBe(-1)
    expect(nav.neighbor(at(4, 4, 5), 5)).toBe(-1)
    expect(nav.neighbor(at(2, 4, 5), 4)).toBe(-1)
    expect(LADDER_COST).toBe(12)
    expect(nav.stepCost(at(4, 7, 5), at(4, 8, 5))).toBe(12)
    expect(nav.stepCost(at(4, 8, 5), at(4, 7, 5))).toBe(12)
  })
  it('climbs the ladder to the top of the wall; the hierarchical route costs the same', () => {
    const { nav, at, layout } = fixture()
    const r = flat(nav, at(2, 4, 5), at(5, 10, 5))
    expect(r.status).toBe('found')
    expect(r.cost).toBe(4 + 4 + 5 * 12 + 6)
    expect(r.path.map((p) => layout.voxelCoords(p).join(','))).toContain('4,8,5')
    const route = new RouteSearch(nav, new RegionStore(nav), at(2, 4, 5), [at(5, 10, 5)])
    while (route.status === 'pending') route.step(4096)
    expect(route.status).toBe('found')
    expect(route.cost).toBe(r.cost)
  })
  it('finds no route once the ladder is gone', () => {
    const { nav, at, cells, layout } = fixture()
    expect(flat(nav, at(2, 4, 5), at(5, 10, 5)).status).toBe('found')
    for (let y = 4; y <= 9; y++) { cells[layout.voxelIndex(4, y, 5)] = 0; nav.invalidate(4, y, 5) }
    expect(flat(nav, at(2, 4, 5), at(5, 10, 5)).status).toBe('unreachable')
    const route = new RouteSearch(nav, new RegionStore(nav), at(2, 4, 5), [at(5, 10, 5)])
    while (route.status === 'pending') route.step(4096)
    expect(route.status).toBe('unreachable')
  })
  it('steps off at any rung onto a ledge beside it', () => {
    const { nav, at } = fixture(true)
    expect(nav.neighbor(at(4, 7, 5), 1)).toBe(at(3, 7, 5))
    expect(nav.neighbor(at(3, 7, 5), 0)).toBe(at(4, 7, 5))
    expect(flat(nav, at(2, 4, 5), at(3, 7, 5)).status).toBe('found')
  })
})
