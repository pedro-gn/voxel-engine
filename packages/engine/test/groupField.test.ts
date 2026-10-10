import { expect, it } from 'vitest'
import { NavigationSystem } from '../src/sim/navigation/navigation.ts'
import { RegionStore, splitKey } from '../src/sim/navigation/regions.ts'
import { RouteSearch } from '../src/sim/navigation/routeSearch.ts'
import { GroupField } from '../src/sim/navigation/groupField.ts'
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
it('ends limited, never unreachable, when its node cap cuts it, and stale when a region it read changes', () => {
  const { nav, layout } = fixture(256), store = new RegionStore(nav)
  const g = new GroupField(nav, store, [layout.voxelIndex(250, 4, 250)], [layout.voxelIndex(2, 4, 2)], 4)
  settle(g)
  expect(g.status).toBe('limited')
  const h = new GroupField(nav, store, [layout.voxelIndex(250, 4, 250)], [layout.voxelIndex(2, 4, 2)])
  h.step(30000); nav.invalidate(250, 4, 250)
  settle(h)
  expect(h.status).toBe('stale')
})
it('mixes its state', () => {
  const { nav, layout } = fixture(64), store = new RegionStore(nav)
  const a = new GroupField(nav, store, [layout.voxelIndex(60, 4, 8)], [layout.voxelIndex(2, 4, 8)])
  const b = new GroupField(nav, store, [layout.voxelIndex(60, 4, 8)], [layout.voxelIndex(2, 4, 9)])
  const sig = (s: GroupField) => { const v: number[] = []; s.mixState(n => v.push(n)); return v }
  expect(sig(a)).not.toEqual(sig(b))
})
it('cancel keeps a settled field and cancels only a pending one, freeing its build', () => {
  const { nav, layout } = fixture(128), store = nav.regions
  const g = new GroupField(nav, store, [layout.voxelIndex(120, 4, 120)], [layout.voxelIndex(4, 4, 4)])
  settle(g); g.cancel(); expect(g.status).toBe('found')
  const cut = new GroupField(nav, store, [layout.voxelIndex(120, 4, 120)], [layout.voxelIndex(4, 4, 4)], 2)
  settle(cut); cut.cancel(); expect(cut.status).toBe('limited')
  const { nav: fresh, layout: l2 } = fixture(64)
  const p = new GroupField(fresh, fresh.regions, [l2.voxelIndex(60, 4, 60)], [l2.voxelIndex(4, 4, 4)])
  p.step(50); expect(fresh.building.size).toBe(1)
  p.cancel(); expect(p.status).toBe('cancelled'); expect(fresh.building.size).toBe(0)
})
