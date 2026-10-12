import { expect, it } from 'vitest'
import { NavigationSystem } from '../src/sim/navigation/navigation.ts'
import { RegionStore, splitKey } from '../src/sim/navigation/regions.ts'
import { RouteSearch } from '../src/sim/navigation/routeSearch.ts'
import { GroupField, startClusters } from '../src/sim/navigation/groupField.ts'
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
function settle(g: GroupField, cap = 4096) { for (let i = 0; i < 100000 && g.status === 'pending'; i++) expect(g.step(cap)).toBeLessThanOrEqual(cap) }

it('agrees with independent route searches for every start of a group', () => {
  const { nav, layout } = fixture(128), store = new RegionStore(nav)
  const goals = [layout.voxelIndex(120, 4, 120), layout.voxelIndex(118, 4, 120)]
  const starts = [layout.voxelIndex(4, 4, 4), layout.voxelIndex(60, 4, 4), layout.voxelIndex(4, 4, 70)]
  const g = new GroupField(nav, store, goals, starts)
  settle(g)
  expect(g.status).toBe('found')
  for (const s of starts) {
    const r = route(nav, store, s, goals)
    expect(g.next(s)!.cost).toBe(r.cost)
  }
})
it('agrees with route searches around walls and a climb, and following next() reaches the goal region', () => {
  const { nav, layout, solid } = fixture(96)
  for (let x = 40; x < 96; x++) for (let z = 0; z < 96; z++) solid.add(layout.voxelIndex(x, 4, z))
  for (let z = 0; z < 80; z++) for (let y = 4; y < 8; y++) solid.add(layout.voxelIndex(20, y, z))
  const store = new RegionStore(nav), goals = [layout.voxelIndex(90, 5, 10)]
  const starts = [layout.voxelIndex(4, 4, 4), layout.voxelIndex(10, 4, 50), layout.voxelIndex(30, 4, 30), layout.voxelIndex(60, 5, 90)]
  const g = new GroupField(nav, store, goals, starts)
  settle(g, 300)
  expect(g.status).toBe('found')
  for (const s of starts) {
    const r = route(nav, store, s, goals), n = g.next(s)!
    expect(n.cost).toBe(r.cost)
    // Walk the exits: each crossing lowers the remaining cost by at least the crossing.
    let pose = s, left = n.cost, guard = 0
    for (let step = g.next(pose)!; step.exit >= 0 && guard++ < 100; step = g.next(pose)!) {
      const [region, e] = splitKey(step.exit), exit = store.get(region)!.exits[e]!
      expect(step.cost).toBeLessThanOrEqual(left); left = step.cost
      pose = exit.to
    }
    expect(nav.tileOfPose(pose)).toBe(nav.tileOfPose(goals[0]!))
  }
})
it('reports unreachable starts with a null next', () => {
  const { nav, layout, solid } = fixture(64)
  for (let x = 30; x <= 34; x++) for (let z = 0; z < 64; z++) for (let y = 4; y < 8; y++) solid.add(layout.voxelIndex(x, y, z))
  const store = new RegionStore(nav), g = new GroupField(nav, store, [layout.voxelIndex(60, 4, 8)], [layout.voxelIndex(4, 4, 8)])
  settle(g)
  expect(g.status).toBe('found')
  expect(g.next(layout.voxelIndex(4, 4, 8))).toBeNull()
})
it('a start inside a goal region descends the goal field', () => {
  const { nav, layout } = fixture(64), store = new RegionStore(nav)
  const g = new GroupField(nav, store, [layout.voxelIndex(40, 4, 40)], [layout.voxelIndex(36, 4, 36), layout.voxelIndex(4, 4, 4)])
  settle(g)
  expect(g.next(layout.voxelIndex(36, 4, 36))).toEqual({ exit: -1, cost: 32 })
  expect(g.next(layout.voxelIndex(4, 4, 4))!.exit).toBeGreaterThan(0)
})
it('ends limited, never unreachable, when its node cap cuts it, and still serves when a goal region changes under it', () => {
  const { nav, layout } = fixture(256), store = new RegionStore(nav)
  const g = new GroupField(nav, store, [layout.voxelIndex(250, 4, 250)], [layout.voxelIndex(2, 4, 2)], 4)
  settle(g)
  expect(g.status).toBe('limited')
  // Units recover from a changed region on their own (nextHop), so the field's costs stay worth serving.
  const h = new GroupField(nav, store, [layout.voxelIndex(250, 4, 250)], [layout.voxelIndex(2, 4, 2)])
  h.step(30000); nav.invalidate(250, 4, 250)
  settle(h)
  expect(h.status).toBe('found'); expect(h.next(layout.voxelIndex(2, 4, 2))).not.toBeNull()
})
it('a field cut by its node cap still serves the starts it settled', () => {
  const { nav, layout } = fixture(256), store = new RegionStore(nav)
  const near = layout.voxelIndex(200, 4, 200), far = layout.voxelIndex(2, 4, 2)
  const whole = new GroupField(nav, store, [layout.voxelIndex(250, 4, 250)], [near, far]); settle(whole)
  const g = new GroupField(nav, store, [layout.voxelIndex(250, 4, 250)], [near, far], Math.ceil((whole as unknown as { d: Map<number, number> }).d.size / 2))
  settle(g)
  expect(g.status).toBe('limited')
  expect(g.next(near)!.cost).toBe(whole.next(near)!.cost)
})
it('a start nothing reaches does not make the field explore the whole world for the others', { timeout: 60_000 }, () => {
  const { nav, layout, solid } = fixture(512)
  // A ring around (40, 4, 300): that start stands, but nothing reaches it.
  for (let x = 38; x <= 42; x++) for (let z = 298; z <= 302; z++) if (x === 38 || x === 42 || z === 298 || z === 302) for (let y = 4; y < 8; y++) solid.add(layout.voxelIndex(x, y, z))
  const goals = [layout.voxelIndex(250, 4, 290)], reachable = [layout.voxelIndex(30, 4, 290), layout.voxelIndex(32, 4, 292)], sealed = layout.voxelIndex(40, 4, 300)
  const alone = new GroupField(nav, new RegionStore(nav, 1 << 30), goals, [sealed]); settle(alone)
  const g = new GroupField(nav, new RegionStore(nav, 1 << 30), goals, [...reachable, sealed]); settle(g)
  expect(g.status).toBe('found')
  for (const s of reachable) expect(g.next(s)).not.toBeNull()
  expect(g.next(sealed)).toBeNull()
  expect(g.spent).toBeLessThan(alone.spent / 3)
})
it('hundreds of starts on one pad cost little more than one: starts are covered by exits, not searched', () => {
  const { nav, layout } = fixture(256), goals = [layout.voxelIndex(230, 4, 128)]
  const pad = Array.from({ length: 256 }, (_, i) => layout.voxelIndex(8 + 2 * (i % 16), 4, 112 + 2 * Math.floor(i / 16)))
  // Warm the store first, so both measure the search alone.
  const store = new RegionStore(nav); settle(new GroupField(nav, store, goals, pad))
  const one = new GroupField(nav, store, goals, [pad[136]!]); settle(one)
  const many = new GroupField(nav, store, goals, pad); settle(many)
  expect(many.status).toBe('found')
  for (const s of pad) expect(many.next(s)).not.toBeNull()
  expect(many.spent).toBeLessThan(one.spent * 1.5 + pad.length * 4)
})
it('splits starts into clusters of nearby columns, chained, in order of first start', () => {
  const { layout } = fixture(512), at = (x: number, z: number) => layout.voxelIndex(x, 4, z)
  // 0 and 2 share a column; 1 is two columns from 0; 3 is far; 4 chains to 3 through 5.
  const starts = [at(10, 10), at(40, 10), at(12, 12), at(300, 300), at(360, 300), at(330, 300)]
  expect(startClusters(starts, layout)).toEqual([[0, 1, 2], [3, 4, 5]])
  expect(startClusters([at(10, 10), at(100, 10)], layout)).toEqual([[0], [1]])
})
it('a change in a region it explored away from its goals and starts leaves the field found', () => {
  const { nav, layout } = fixture(128)
  const goals = [layout.voxelIndex(120, 4, 64)], starts = [layout.voxelIndex(4, 4, 64)]
  const first = new GroupField(nav, new RegionStore(nav), goals, starts); settle(first)
  const pinned = new Set([...goals, ...starts].map(p => nav.tileOfPose(p)))
  const off = [...first.seen.keys()].find(i => !pinned.has(i))
  expect(off).toBeDefined()
  const g = new GroupField(nav, new RegionStore(nav), goals, starts)
  while (g.status === 'pending' && !g.seen.has(off!)) g.step(64)
  const [sx, , sz] = layout.size, tx = sx >> 4, tz = sz >> 4
  nav.invalidate((off! % tx) * 16 + 8, Math.floor(off! / (tx * tz)) * 16 + 8, (Math.floor(off! / tx) % tz) * 16 + 8)
  settle(g)
  expect(g.status).toBe('found'); expect(g.next(starts[0]!)!.cost).toBe(first.next(starts[0]!)!.cost)
})
it('mixes its state', () => {
  const { nav, layout } = fixture(64), store = new RegionStore(nav)
  const a = new GroupField(nav, store, [layout.voxelIndex(60, 4, 8)], [layout.voxelIndex(2, 4, 8)])
  const b = new GroupField(nav, store, [layout.voxelIndex(60, 4, 8)], [layout.voxelIndex(2, 4, 9)])
  const sig = (s: GroupField) => { const v: number[] = []; s.mixState(n => v.push(n)); return v }
  expect(sig(a)).not.toEqual(sig(b))
})
it('cancel keeps a settled field and cancels only a pending one, leaving its build shared', () => {
  const { nav, layout } = fixture(128), store = nav.regions
  const g = new GroupField(nav, store, [layout.voxelIndex(120, 4, 120)], [layout.voxelIndex(4, 4, 4)])
  settle(g); g.cancel(); expect(g.status).toBe('found')
  const cut = new GroupField(nav, store, [layout.voxelIndex(120, 4, 120)], [layout.voxelIndex(4, 4, 4)], 2)
  settle(cut); cut.cancel(); expect(cut.status).toBe('limited')
  const { nav: fresh, layout: l2 } = fixture(64)
  const p = new GroupField(fresh, fresh.regions, [l2.voxelIndex(60, 4, 60)], [l2.voxelIndex(4, 4, 4)])
  p.step(50); expect(fresh.building.size).toBe(1)
  const job = [...fresh.building.values()][0]!
  p.cancel(); expect(p.status).toBe('cancelled'); expect(fresh.building.get(job.index)).toBe(job)
})
