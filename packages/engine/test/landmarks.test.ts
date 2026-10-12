import { expect, it } from 'vitest'
import { NavigationSystem } from '../src/sim/navigation/navigation.ts'
import { GroupField } from '../src/sim/navigation/groupField.ts'
import { RouteSearch } from '../src/sim/navigation/routeSearch.ts'
import { BlockRegistry } from '../src/blocks/registry.ts'
import { Layout } from '../src/world/layout.ts'

/**
 * A 256² floor at y = 4 split by a wall at x = 128 that leaves a gap only at z >= 232: going east from the south means a
 * detour of some 420 blocks, which the flat heuristic does not see. `walls` holds extra solid voxels, `open` holes in the wall.
 */
function detour() {
  const layout = new Layout([256, 32, 256]), registry = new BlockRegistry([{ name: 'stone' }]), walls = new Set<number>(), open = new Set<number>()
  const get = (x: number, y: number, z: number) => y < 4 || x === 128 && z < 232 && y < 12 && !open.has(layout.voxelIndex(x, y, z)) || walls.has(layout.voxelIndex(x, y, z)) ? 1 : 0
  const nav = new NavigationSystem({ layout, registry, get }, 1 << 20)
  return { nav, layout, walls, open }
}
function warm(nav: NavigationSystem) {
  for (let i = 0; i < 20000 && !nav.prebuildStatus().done; i++) expect(nav.prebuild(8192, [])).toBeLessThanOrEqual(8192)
  expect(nav.prebuildStatus()).toMatchObject({ done: true, landmarks: true })
}
function settle<T extends { status: string; step(cap: number): number }>(s: T): T { while (s.status === 'pending') expect(s.step(4096)).toBeLessThanOrEqual(4096); return s }
/** Exact flat A*; with `solidGround`, no pose on a falling block, as the live policy and the region layer. */
function flat(nav: NavigationSystem, start: number, goal: number, solidGround = false) {
  const L = nav.port.layout, s = nav.request(start, [goal], undefined, solidGround ? { allowed: p => nav.regionStand(...L.voxelCoords(p)) } : undefined)
  while (s.status === 'pending') nav.step(1 << 20)
  return s
}

it('landmark tables come with the warm world, from the prebuild, and make a detour cheap to find', { timeout: 60_000 }, () => {
  const { nav, layout } = detour()
  expect(nav.landmarks.current()).toBeNull()
  warm(nav)
  const tables = nav.landmarks.current()!
  expect(tables.count).toBeGreaterThanOrEqual(4)
  const start = layout.voxelIndex(20, 4, 20), goal = layout.voxelIndex(236, 4, 20), exact = flat(nav, start, goal)
  expect(exact.status).toBe('found')
  const plain = settle(new RouteSearch(nav, nav.regions, start, [goal], { landmarks: null }))
  const alt = settle(new RouteSearch(nav, nav.regions, start, [goal]))
  expect(alt.status).toBe('found'); expect(plain.status).toBe('found')
  expect(alt.cost).toBeGreaterThanOrEqual(exact.cost); expect(alt.cost).toBeLessThanOrEqual(1.25 * exact.cost)
  expect(alt.spent * 3).toBeLessThan(plain.spent)
  // A group field from the east toward ten units in the south-west.
  const starts = Array.from({ length: 10 }, (_, i) => layout.voxelIndex(16 + i, 4, 16 + (i & 1)))
  const plainGroup = settle(new GroupField(nav, nav.regions, [goal], starts, 65536, undefined, { landmarks: null }))
  const altGroup = settle(new GroupField(nav, nav.regions, [goal], starts))
  for (const s of starts) {
    const n = altGroup.next(s)!, e = flat(nav, s, goal)
    expect(n.cost).toBeGreaterThanOrEqual(e.cost); expect(n.cost).toBeLessThanOrEqual(1.25 * e.cost)
  }
  expect(altGroup.spent * 3).toBeLessThan(plainGroup.spent)
})
it('with landmarks, routes agree with exact flat A* on reachability and stay within the weight bound', { timeout: 60_000 }, () => {
  const { nav, layout, walls } = detour()
  // A walled-in pen around (60, 4, 200): nothing reaches inside.
  for (let x = 56; x <= 64; x++) for (let z = 196; z <= 204; z++) if (x === 56 || x === 64 || z === 196 || z === 204) for (let y = 4; y < 8; y++) walls.add(layout.voxelIndex(x, y, z))
  warm(nav)
  const points = [[20, 20], [236, 20], [60, 200], [200, 250], [10, 240], [250, 128], [100, 100], [160, 30]] as const
  for (const [ax, az] of points) for (const [bx, bz] of points) {
    if (ax === bx && az === bz) continue
    const a = layout.voxelIndex(ax, 4, az), b = layout.voxelIndex(bx, 4, bz), e = flat(nav, a, b), r = settle(new RouteSearch(nav, nav.regions, a, [b]))
    const where = `${ax},${az} -> ${bx},${bz}`
    expect(r.status, where).toBe(e.status)
    if (e.status === 'found') { expect(r.cost, where).toBeGreaterThanOrEqual(e.cost); expect(r.cost, where).toBeLessThanOrEqual(1.25 * e.cost) }
  }
})
it('a solid edit retires the tables until the prebuild has recomputed them; a falls-only change where one was seen does not', { timeout: 60_000 }, () => {
  const { nav, layout, open } = detour()
  nav.invalidate(30, 4, 30, false)
  warm(nav)
  const before = nav.landmarks.current()
  nav.invalidate(30, 4, 30, false)
  expect(nav.landmarks.current()).toBe(before)
  // A gap opened in the wall: the old tables would overestimate through it, so no new query reads them.
  for (const y of [4, 5]) { open.add(layout.voxelIndex(128, y, 20)); nav.invalidate(128, y, 20) }
  expect(nav.landmarks.current()).toBeNull()
  expect(nav.prebuildStatus().done).toBe(false)
  warm(nav)
  expect(nav.landmarks.current()).not.toBe(before)
  // Through the gap now: the route finds the short way.
  const start = layout.voxelIndex(20, 4, 20), goal = layout.voxelIndex(236, 4, 20), r = settle(new RouteSearch(nav, nav.regions, start, [goal]))
  expect(r.status).toBe('found'); expect(r.cost).toBeLessThanOrEqual(1.25 * flat(nav, start, goal).cost)
})
it('the tables stay a lower bound when sand gets wet and opens a way the regions did not have', { timeout: 120_000 }, () => {
  // The wall at x = 128 has a doorway at z 16..24 whose floor is sand: no region pose stands there until it gets wet.
  const layout = new Layout([256, 32, 256]), registry = new BlockRegistry([{ name: 'stone' }, { name: 'sand', falls: true }, { name: 'wet_sand' }])
  const STONE = registry.id('stone'), SAND = registry.id('sand'), WET = registry.id('wet_sand'), door = (z: number) => z >= 16 && z <= 24
  let wet = false
  const get = (x: number, y: number, z: number) => x === 128 && y === 3 && door(z) ? wet ? WET : SAND : y < 4 || x === 128 && z < 232 && y < 12 && !door(z) ? STONE : 0
  const nav = new NavigationSystem({ layout, registry, get }, 1 << 20)
  warm(nav)
  const routesWithin = () => {
    for (const [ax, az, bx, bz] of [[20, 20, 236, 20], [100, 20, 156, 20], [120, 100, 140, 100], [64, 10, 200, 30]] as const) {
      const a = layout.voxelIndex(ax, 4, az), b = layout.voxelIndex(bx, 4, bz), e = flat(nav, a, b), r = settle(new RouteSearch(nav, nav.regions, a, [b]))
      expect(r.cost, `${ax},${az} -> ${bx},${bz}`).toBeLessThanOrEqual(1.25 * e.cost)
    }
  }
  wet = true
  for (let z = 16; z <= 24; z++) nav.invalidate(128, 3, z, false)
  // The first falls-only change in a tile retires the tables: they had that sand as a barrier.
  expect(nav.landmarks.current()).toBeNull()
  // Computed again, they treat the sand of tiles that have changed so as standable, so it can flip back and forth.
  warm(nav)
  const tables = nav.landmarks.current()
  routesWithin()
  wet = false
  for (let z = 16; z <= 24; z++) nav.invalidate(128, 3, z, false)
  wet = true
  for (let z = 16; z <= 24; z++) nav.invalidate(128, 3, z, false)
  expect(nav.landmarks.current()).toBe(tables)
  while (!nav.prebuilt) nav.prebuild(8192, [])
  routesWithin()
})
it('sand that has never changed stays a barrier in the tables, so a detour around it is cheap to find', { timeout: 120_000 }, () => {
  // A strip of sand at x = 128 for z < 232: nothing stands on it, so the way east goes around its end.
  const layout = new Layout([256, 32, 256]), registry = new BlockRegistry([{ name: 'stone' }, { name: 'sand', falls: true }])
  const STONE = registry.id('stone'), SAND = registry.id('sand')
  const nav = new NavigationSystem({ layout, registry, get: (x, y, z) => x === 128 && y === 3 && z < 232 ? SAND : y < 4 ? STONE : 0 }, 1 << 20)
  warm(nav)
  const start = layout.voxelIndex(20, 4, 20), goal = layout.voxelIndex(236, 4, 20)
  const plain = settle(new RouteSearch(nav, nav.regions, start, [goal], { landmarks: null })), alt = settle(new RouteSearch(nav, nav.regions, start, [goal]))
  expect(alt.status).toBe('found'); expect(alt.cost).toBeLessThanOrEqual(1.25 * flat(nav, start, goal, true).cost)
  expect(alt.spent * 3).toBeLessThan(plain.spent)
})
it('edits every few ticks retire the tables but do not restart their computation until the edits settle', { timeout: 120_000 }, () => {
  const { nav, layout, open } = detour()
  warm(nav)
  const step = nav.landmarks.step.bind(nav.landmarks)
  let landmarkOps = 0
  nav.landmarks.step = (cap: number, now?: number) => { const n = step(cap, now); landmarkOps += n; return n }
  // A block toggled every 10 ticks for 1,000 ticks, the prebuild running with spare budget each tick.
  let tick = 1000
  for (let i = 0; i < 1000; i++, tick++) {
    if (i % 10 === 0) { const p = layout.voxelIndex(60, 4, 60); if (open.has(p)) open.delete(p); else open.add(p); nav.invalidate(60, 4, 60) }
    nav.prebuild(8192, [], tick)
  }
  expect(nav.landmarks.current()).toBeNull()
  expect(landmarkOps).toBeLessThan(8192)
  // Once the edits stop for long enough, the tables are computed again.
  for (let i = 0; i < 20000 && !nav.landmarks.current(); i++, tick++) nav.prebuild(8192, [], tick)
  expect(nav.landmarks.current()).not.toBeNull()
})
it('a search cut short is remembered by geometry and flip counts apart, with no aliasing between them', () => {
  const { nav } = detour()
  const l = nav.landmarks as unknown as { failed: unknown; settled(): boolean }
  l.failed = { geometry: 0, flips: 65536 }
  nav.flips = 0; nav.geometry = 1
  // 1 * 0x10000 + 0 would equal 0 * 0x10000 + 65536.
  expect(l.settled()).toBe(false)
})
