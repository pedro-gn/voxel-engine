import { expect, it } from 'vitest'
import { NavigationSystem } from '../src/sim/navigation/navigation.ts'
import { RegionStore } from '../src/sim/navigation/regions.ts'
import { RouteSearch } from '../src/sim/navigation/routeSearch.ts'
import { BlockRegistry } from '../src/blocks/registry.ts'
import { Layout } from '../src/world/layout.ts'

function fixture(side = 64, solid = new Set<number>()) {
  const layout = new Layout([side, 32, side]), registry = new BlockRegistry([{ name: 'stone' }])
  const nav = new NavigationSystem({ layout, registry, get: (x, y, z) => y < 4 || solid.has(layout.voxelIndex(x, y, z)) ? 1 : 0 })
  return { nav, layout, solid }
}
function route(nav: NavigationSystem, store: RegionStore, start: number, goals: number[], cap = 512, options = {}) {
  const s = new RouteSearch(nav, store, start, goals, options)
  for (let i = 0; i < 100000 && s.status === 'pending'; i++) expect(s.step(cap)).toBeLessThanOrEqual(cap)
  return s
}
function flat(nav: NavigationSystem, start: number, goals: number[]) {
  const s = nav.request(start, goals)
  while (s.status === 'pending') nav.step(4096)
  return s
}

it('crosses an open 128² floor with a cost within 1.25× of the flat optimum', () => {
  const { nav, layout } = fixture(128), store = new RegionStore(nav)
  const s = route(nav, store, layout.voxelIndex(2, 4, 2), [layout.voxelIndex(125, 4, 125)])
  expect(s.status).toBe('found')
  expect(s.cost).toBeGreaterThanOrEqual(246 * 4); expect(s.cost).toBeLessThanOrEqual(246 * 4 * 1.25)
  expect(s.exits.length).toBeGreaterThan(10)
  expect(s.goal).toBe(layout.voxelIndex(125, 4, 125))
  // Each exit leaves the region the previous one entered.
  for (let i = 1; i < s.exits.length; i++) expect(nav.tileOfPose(s.exits[i]!)).not.toBe(nav.tileOfPose(s.exits[i - 1]!))
})
it('finds a goal inside the start region without leaving it', () => {
  const { nav, layout } = fixture(64), store = new RegionStore(nav)
  const s = route(nav, store, layout.voxelIndex(2, 4, 2), [layout.voxelIndex(12, 4, 9)])
  expect(s.status).toBe('found'); expect(s.cost).toBe(17 * 4); expect(s.exits).toEqual([])
})
it('proves unreachable for an enclosed goal after building only the regions it touched', () => {
  const { nav, layout, solid } = fixture(128)
  for (let x = 98; x <= 102; x++) for (let z = 98; z <= 102; z++) if (x === 98 || x === 102 || z === 98 || z === 102) for (let y = 4; y < 8; y++) solid.add(layout.voxelIndex(x, y, z))
  const store = new RegionStore(nav)
  const s = route(nav, store, layout.voxelIndex(5, 4, 5), [layout.voxelIndex(100, 4, 100)], 4096)
  expect(s.status).toBe('unreachable')
})
it('a goal reachable only by dropping is unreachable in the other direction', () => {
  const { nav, layout, solid } = fixture(64)
  for (let x = 0; x < 32; x++) for (let z = 0; z < 64; z++) for (let y = 4; y < 6; y++) solid.add(layout.voxelIndex(x, y, z))
  const store = new RegionStore(nav)
  expect(route(nav, store, layout.voxelIndex(4, 6, 4), [layout.voxelIndex(60, 4, 60)]).status).toBe('found')
  expect(route(nav, store, layout.voxelIndex(60, 4, 60), [layout.voxelIndex(4, 6, 4)]).status).toBe('unreachable')
})
it('ends limited, never unreachable, when its node cap cuts the search', () => {
  const { nav, layout } = fixture(256), store = new RegionStore(nav)
  const s = route(nav, store, layout.voxelIndex(2, 4, 2), [layout.voxelIndex(250, 4, 250)], 512, { maxNodes: 4 })
  expect(s.status).toBe('limited')
})
it('ends stale when a region it read changes before it finishes', () => {
  const { nav, layout } = fixture(128), store = new RegionStore(nav)
  const s = new RouteSearch(nav, store, layout.voxelIndex(2, 4, 2), [layout.voxelIndex(125, 4, 125)])
  s.step(20000); nav.invalidate(3, 4, 3)
  while (s.status === 'pending') s.step(4096)
  expect(s.status).toBe('stale')
})
it('excluded exits are not used, and an exhausted search that skipped one is limited', () => {
  const { nav, layout, solid } = fixture(64), store = new RegionStore(nav)
  const a = route(nav, store, layout.voxelIndex(2, 4, 8), [layout.voxelIndex(60, 4, 8)])
  const b = route(nav, store, layout.voxelIndex(2, 4, 8), [layout.voxelIndex(60, 4, 8)], 512, { exclude: new Set([a.exits[0]!]) })
  expect(b.status).toBe('found'); expect(b.exits).not.toContain(a.exits[0])
  // A one-wide gap in a wall at x=16: excluding its only exit cuts the route without proving anything.
  for (let z = 0; z < 64; z++) if (z !== 8) for (let y = 4; y < 8; y++) solid.add(layout.voxelIndex(16, y, z))
  nav.invalidateBox(16, 4, 0, 16, 7, 63)
  const c = route(nav, store, layout.voxelIndex(2, 4, 8), [layout.voxelIndex(60, 4, 8)])
  expect(c.status).toBe('found')
  const d = route(nav, store, layout.voxelIndex(2, 4, 8), [layout.voxelIndex(60, 4, 8)], 512, { exclude: new Set([c.exits[0]!]) })
  expect(d.status).toBe('limited')
})
it('agrees with flat A* on reachability and stays near its cost with a climb on the way', () => {
  const { nav, layout, solid } = fixture(64)
  // A step up by one at x >= 30 and a wall with one gap at z = 50.
  for (let x = 30; x < 64; x++) for (let z = 0; z < 64; z++) solid.add(layout.voxelIndex(x, 4, z))
  for (let x = 0; x < 30; x++) if (x !== 3) for (let y = 4; y < 8; y++) solid.add(layout.voxelIndex(x, y, 40))
  const store = new RegionStore(nav)
  const start = layout.voxelIndex(5, 4, 5), goal = layout.voxelIndex(10, 4, 60)
  const r = route(nav, store, start, [goal]), f = flat(nav, start, [goal])
  expect(r.status).toBe('found'); expect(f.status).toBe('found')
  expect(r.cost).toBeGreaterThanOrEqual(f.cost); expect(r.cost).toBeLessThanOrEqual(f.cost * 1.25)
})
it('two searches with different state mix differently', () => {
  const { nav, layout } = fixture(64), store = new RegionStore(nav)
  const a = new RouteSearch(nav, store, layout.voxelIndex(2, 4, 8), [layout.voxelIndex(60, 4, 8)])
  const b = new RouteSearch(nav, store, layout.voxelIndex(2, 4, 9), [layout.voxelIndex(60, 4, 8)])
  const sig = (s: RouteSearch) => { const v: number[] = []; s.mixState(n => v.push(n)); return v }
  expect(sig(a)).not.toEqual(sig(b))
  a.step(3000); b.step(3001)
  expect(sig(a)).not.toEqual(sig(b))
})
it('a settled route frees its scratch and keeps only the regions its segments cross', () => {
  const { nav, layout, solid } = fixture(128)
  for (let x = 98; x <= 102; x++) for (let z = 98; z <= 102; z++) if (x === 98 || x === 102 || z === 98 || z === 102) for (let y = 4; y < 8; y++) solid.add(layout.voxelIndex(x, y, z))
  const store = new RegionStore(nav), start = layout.voxelIndex(2, 4, 2)
  const s = route(nav, store, start, [layout.voxelIndex(60, 4, 70)])
  expect(s.status).toBe('found')
  const crossed = new Set([nav.tileOfPose(start), ...s.exits.map(p => nav.tileOfPose(p)), nav.tileOfPose(s.goal)])
  for (const index of crossed) expect(s.region(index)).toBeDefined()
  expect(s.region(nav.tileOf(120, 4, 120))).toBeUndefined()
  expect(s.goalFields.size).toBe(1); expect(s.bytes).toBe(s.goalFields.get(nav.tileOfPose(s.goal))!.byteLength)
  const u = route(nav, store, start, [layout.voxelIndex(100, 4, 100)])
  expect(u.status).toBe('unreachable'); expect(u.region(nav.tileOfPose(start))).toBeUndefined(); expect(u.seen.size).toBeGreaterThan(1)
})
it('reuses regions from the store: a second identical search costs far less', () => {
  const { nav, layout } = fixture(128), store = new RegionStore(nav)
  const a = route(nav, store, layout.voxelIndex(2, 4, 2), [layout.voxelIndex(125, 4, 125)])
  const b = route(nav, store, layout.voxelIndex(2, 4, 2), [layout.voxelIndex(125, 4, 125)])
  expect(b.cost).toBe(a.cost); expect(b.exits).toEqual(a.exits)
  expect(b.spent * 10).toBeLessThan(a.spent)
})
