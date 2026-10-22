import { expect, it } from 'vitest'
import { NavigationSystem } from '../src/sim/navigation/navigation.ts'
import { RegionStore } from '../src/sim/navigation/regions.ts'
import { RouteSearch } from '../src/sim/navigation/routeSearch.ts'
import { GroupField } from '../src/sim/navigation/groupField.ts'
import type { Layout } from '../src/world/layout.ts'
import { HIER_MIN } from '../src/sim/workers/workers.ts'
import { fuzzWorld, standing } from './fuzzWorld.ts'

const WORLDS = 40, PAIRS = 25
/** Units route only past HIER_MIN; shorter pairs check reachability alone (one crossing through a run's middle can cost 1.7× on a 6-block walk). */
const routed = (L: Layout, a: number, b: number) => { const [x, y, z] = L.voxelCoords(a), [gx, gy, gz] = L.voxelCoords(b); return (Math.abs(x - gx) + Math.abs(z - gz)) * 4 + Math.max(0, gy - y) * 2 > HIER_MIN }

// Plain: the flat heuristic on a cold store. Landmarks: a world warmed by the prebuild, with ALT tables.
for (const ladders of [false, true]) for (const landmarks of [false, true]) it(`routes agree with exact flat A* on reachability, and routed pairs stay near its cost, on fuzzed terrain (${landmarks ? 'landmarks' : 'plain'}${ladders ? ', ladders' : ''})`, { timeout: 120_000 }, () => {
  const ratios: number[] = []
  let unreachable = 0, groups = 0
  for (let seed = 1; seed <= WORLDS; seed++) {
    const { layout, rng, port } = fuzzWorld(seed, ladders), nav = new NavigationSystem(port, 1 << 20)
    if (landmarks) while (!nav.prebuildStatus().done) nav.prebuild(1 << 16, [])
    const store = landmarks ? nav.regions : new RegionStore(nav)
    expect(nav.landmarks.current() !== null).toBe(landmarks)
    const pairs = Array.from({ length: PAIRS }, () => [standing(nav, layout, rng), standing(nav, layout, rng)] as const)
    for (const [i, [start, goal]] of pairs.entries()) {
      const flat = nav.request(start, [goal])
      while (flat.status === 'pending') nav.step(1 << 20)
      const route = new RouteSearch(nav, store, start, [goal])
      while (route.status === 'pending') expect(route.step(4096)).toBeLessThanOrEqual(4096)
      const where = `seed ${seed} pair ${i}: ${layout.voxelCoords(start)} -> ${layout.voxelCoords(goal)}`
      expect(route.status, where).toBe(flat.status)
      if (flat.status === 'unreachable') { unreachable++; continue }
      expect(route.cost, where).toBeGreaterThanOrEqual(flat.cost)
      if (!routed(layout, start, goal)) continue
      expect(route.cost, where).toBeLessThanOrEqual(1.25 * flat.cost)
      if (flat.cost) ratios.push(route.cost / flat.cost)
    }
    // One group field toward the first pair's goal: reachability agrees for every start of the world.
    const goal = pairs[0]![1], group = new GroupField(nav, store, [goal], pairs.map(p => p[0]))
    while (group.status === 'pending') group.step(4096)
    expect(group.status).toBe('found')
    for (const [start] of pairs) {
      const flat = nav.request(start, [goal])
      while (flat.status === 'pending') nav.step(1 << 20)
      const n = group.next(start)
      expect(n === null, `seed ${seed} group start ${layout.voxelCoords(start)}`).toBe(flat.status === 'unreachable')
      if (n) { expect(n.cost).toBeGreaterThanOrEqual(flat.cost); if (routed(layout, start, goal)) expect(n.cost).toBeLessThanOrEqual(1.25 * flat.cost) }
      groups++
    }
  }
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length, sorted = [...ratios].sort((a, b) => a - b)
  console.log(`route fuzz (${landmarks ? 'landmarks' : 'plain'}${ladders ? ', ladders' : ''}): ${ratios.length} routed found, ${unreachable} unreachable, ${groups} group starts; cost ratio mean ${mean.toFixed(4)} p95 ${sorted[Math.floor(sorted.length * 0.95)]!.toFixed(4)} max ${sorted.at(-1)!.toFixed(4)}`)
  expect(unreachable).toBeGreaterThan(0)
  expect(mean).toBeLessThanOrEqual(1.10)
  expect(sorted[Math.floor(sorted.length * 0.95)]!).toBeLessThanOrEqual(1.25)
})
