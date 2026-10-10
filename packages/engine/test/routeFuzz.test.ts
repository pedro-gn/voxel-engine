import { expect, it } from 'vitest'
import { NavigationSystem } from '../src/sim/navigation/navigation.ts'
import { RegionStore } from '../src/sim/navigation/regions.ts'
import { RouteSearch } from '../src/sim/navigation/routeSearch.ts'
import { GroupField } from '../src/sim/navigation/groupField.ts'
import { BlockRegistry } from '../src/blocks/registry.ts'
import { Layout } from '../src/world/layout.ts'
import { Pcg32 } from '../src/sim/rng.ts'
import { HIER_MIN } from '../src/sim/workers/workers.ts'

const SIDE = 96, WORLDS = 40, PAIRS = 25
/** Units route only past HIER_MIN; shorter pairs check reachability alone (one crossing through a run's middle can cost 1.7× on a 6-block walk). */
const routed = (L: Layout, a: number, b: number) => { const [x, y, z] = L.voxelCoords(a), [gx, gy, gz] = L.voxelCoords(b); return (Math.abs(x - gx) + Math.abs(z - gz)) * 4 + Math.max(0, gy - y) * 2 > HIER_MIN }

/** Seeded 96 × 32 × 96 terrain: hills 4–9 high, three walls, and a cave tunnel whose stair entrance exists every other world. */
function world(seed: number) {
  const rng = new Pcg32(seed), layout = new Layout([SIDE, 32, SIDE]), solid = new Uint8Array(layout.voxelCount)
  const hills = Array.from({ length: 4 }, () => [rng.nextInt(SIDE), rng.nextInt(SIDE), 10 + rng.nextInt(30), 1 + rng.nextInt(5)] as const)
  for (let z = 0; z < SIDE; z++) for (let x = 0; x < SIDE; x++) {
    let h = 4
    for (const [hx, hz, r, top] of hills) h += Math.max(0, Math.floor(top * (r - Math.hypot(x - hx, z - hz)) / r))
    for (let y = 0; y < Math.min(9, h); y++) solid[layout.voxelIndex(x, y, z)] = 1
  }
  const top = (x: number, z: number) => { let y = 31; while (y > 0 && !solid[layout.voxelIndex(x, y - 1, z)]) y--; return y }
  for (let w = 0; w < 3; w++) {
    const along = rng.nextInt(2), length = 10 + rng.nextInt(40), x0 = rng.nextInt(SIDE), z0 = rng.nextInt(SIDE)
    for (let i = 0; i < length; i++) {
      const x = along ? Math.min(SIDE - 1, x0 + i) : x0, z = along ? z0 : Math.min(SIDE - 1, z0 + i), y0 = top(x, z)
      for (let y = y0; y < Math.min(31, y0 + 4); y++) solid[layout.voxelIndex(x, y, z)] = 1
    }
  }
  // A tunnel at y = 1..2 along x; its stair climbs one block per step toward -x up to the surface.
  const tz = 8 + rng.nextInt(SIDE - 16), tx0 = 30 + rng.nextInt(20), tx1 = Math.min(SIDE - 2, tx0 + 20 + rng.nextInt(30))
  for (let x = tx0; x <= tx1; x++) for (let y = 1; y <= 2; y++) solid[layout.voxelIndex(x, y, tz)] = 0
  if (seed % 2 === 0) {
    solid[layout.voxelIndex(tx0, 3, tz)] = 0 // headroom to climb out of the tunnel
    for (let s = 1; tx0 - s >= 0 && 1 + s < top(tx0 - s, tz); s++) for (let y = 1 + s; y < 31; y++) solid[layout.voxelIndex(tx0 - s, y, tz)] = 0
  }
  const registry = new BlockRegistry([{ name: 'stone' }])
  return { layout, rng, port: { layout, registry, get: (x: number, y: number, z: number) => layout.inBounds(x, y, z) ? solid[layout.voxelIndex(x, y, z)]! : 0 } }
}
function standing(nav: NavigationSystem, layout: Layout, rng: Pcg32): number {
  for (;;) {
    const x = rng.nextInt(SIDE), z = rng.nextInt(SIDE), ys: number[] = []
    for (let y = 0; y < 31; y++) if (nav.stand(x, y, z)) ys.push(y)
    if (ys.length) return layout.voxelIndex(x, ys[rng.nextInt(ys.length)]!, z)
  }
}

it('routes agree with exact flat A* on reachability, and routed pairs stay near its cost, on fuzzed terrain', { timeout: 120_000 }, () => {
  const ratios: number[] = []
  let unreachable = 0, groups = 0
  for (let seed = 1; seed <= WORLDS; seed++) {
    const { layout, rng, port } = world(seed), nav = new NavigationSystem(port, 1 << 20), store = new RegionStore(nav)
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
  console.log(`route fuzz: ${ratios.length} routed found, ${unreachable} unreachable, ${groups} group starts; cost ratio mean ${mean.toFixed(4)} p95 ${sorted[Math.floor(sorted.length * 0.95)]!.toFixed(4)} max ${sorted.at(-1)!.toFixed(4)}`)
  expect(unreachable).toBeGreaterThan(0)
  expect(mean).toBeLessThanOrEqual(1.10)
  expect(sorted[Math.floor(sorted.length * 0.95)]!).toBeLessThanOrEqual(1.25)
})
