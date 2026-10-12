import { expect, it } from 'vitest'
import { NavigationSystem } from '../src/sim/navigation/navigation.ts'
import { BlockRegistry } from '../src/blocks/registry.ts'
import { Layout } from '../src/world/layout.ts'
import { EngineeringSearch } from '../src/sim/navigation/engineering.ts'

function fixture(side = 64, blocked = new Set<number>()) {
  const layout = new Layout([side, 32, side]), registry = new BlockRegistry([{ name: 'stone' }])
  const nav = new NavigationSystem({ layout, registry, get: (x, y, z) => y < 4 || blocked.has(layout.voxelIndex(x, y, z)) ? 1 : 0 })
  return { nav, layout, blocked }
}
function finish(nav: NavigationSystem, start: number, goal: number, budget = 7) {
  const s = nav.request(start, [goal])
  for (let i = 0; i < 100000 && s.status === 'pending'; i++) { nav.step(budget); expect(nav.visited).toBeLessThanOrEqual(budget) }
  return s.result()
}

it('reconstructs every local step of a long flat route with exact cost', () => {
  const { nav, layout } = fixture(128)
  const r = finish(nav, layout.voxelIndex(2, 4, 2), layout.voxelIndex(125, 4, 125))
  expect(r.status).toBe('found'); expect(r.cost).toBe(246 * 4); expect(r.path).toHaveLength(247)
  for (let i = 1; i < r.path.length; i++) { const a = layout.voxelCoords(r.path[i - 1]!), b = layout.voxelCoords(r.path[i]!); expect(Math.abs(a[0] - b[0]) + Math.abs(a[2] - b[2])).toBe(1) }
})
it('keeps a cave floor and upper floor distinct and checks ascent headroom', () => {
  const { nav, layout, blocked } = fixture()
  for (let x = 8; x < 20; x++) for (let z = 8; z < 20; z++) blocked.add(layout.voxelIndex(x, 9, z))
  expect(nav.stand(12, 4, 12)).toBe(true); expect(nav.stand(12, 10, 12)).toBe(true)
  expect(finish(nav, layout.voxelIndex(12, 4, 12), layout.voxelIndex(12, 10, 12)).status).toBe('unreachable')
  blocked.add(layout.voxelIndex(6, 4, 5)); nav.invalidate(6, 4, 5)
  expect(nav.neighbor(layout.voxelIndex(5, 4, 5), 0)).toBe(layout.voxelIndex(6, 5, 5))
  blocked.add(layout.voxelIndex(5, 6, 5)); nav.invalidate(5, 6, 5)
  expect(nav.neighbor(layout.voxelIndex(5, 4, 5), 0)).toBe(-1)
})
it('invalidates the halo when an adjacent tile changes during a sliced search', () => {
  const { nav, layout, blocked } = fixture()
  const s = nav.request(layout.voxelIndex(14, 4, 5), [layout.voxelIndex(60, 4, 5)])
  nav.step(20); blocked.add(layout.voxelIndex(16, 4, 5)); nav.invalidate(16, 4, 5)
  while (s.status === 'pending') nav.step(128)
  expect(s.status).toBe('stale')
  const r = finish(nav, layout.voxelIndex(14, 4, 5), layout.voxelIndex(60, 4, 5))
  expect(r.status).toBe('found'); expect(r.path).not.toContain(layout.voxelIndex(16, 4, 5))
})
it('keeps scratch proportional to discovered positions, not world volume', () => {
  const { nav, layout } = fixture(1024)
  const r = finish(nav, layout.voxelIndex(2, 4, 2), layout.voxelIndex(22, 4, 2), 128)
  expect(r.status).toBe('found'); expect(nav.bytes).toBeLessThan(1048576)
})

it('asks a rejecting policy at most once per pose within a pass', () => {
  const layout = new Layout([64, 32, 64]), registry = new BlockRegistry([{ name: 'stone' }]), calls = new Map<number, number>()
  // A fence at x = 20 the policy rejects, open only at z = 40: the search must walk around it.
  const port = { layout, registry, get: (_x: number, y: number) => y < 4 ? 1 : 0, safe: (x: number, y: number, z: number) => { const p = layout.voxelIndex(x, y, z); calls.set(p, (calls.get(p) ?? 0) + 1); return x !== 20 || z === 40 } }
  const start = layout.voxelIndex(10, 4, 10), goal = layout.voxelIndex(30, 4, 10)
  const nav = new NavigationSystem(port), s = nav.request(start, [goal])
  nav.step(1 << 20)
  expect(s.result()).toMatchObject({ status: 'found', cost: (20 + 30 + 30) * 4 })
  expect(calls.get(layout.voxelIndex(20, 4, 10))).toBe(1)
  expect(Math.max(...calls.values())).toBe(1)
  // Sliced over many passes, the search finds the same path.
  const sliced = new NavigationSystem({ ...port, safe: (x: number, _y: number, z: number) => x !== 20 || z === 40 })
  expect(finish(sliced, start, goal)).toEqual(s.result())
})
it('invalidates pending allowed-pose queries while retaining cached geometry edges', () => {
  const { nav, layout } = fixture()
  const start = layout.voxelIndex(5, 4, 5), goal = layout.voxelIndex(8, 4, 5)
  const adjacent = nav.neighbor(start, 0), tiles = nav.cacheTiles
  const s = nav.request(start, [goal]); nav.step(1)
  expect(s.status).toBe('pending')
  nav.invalidatePolicy()
  expect(s.status).toBe('cancelled')
  expect(nav.cacheTiles).toBe(tiles); expect(nav.neighbor(start, 0)).toBe(adjacent)
  expect(finish(nav, start, goal)).toMatchObject({ status: 'found', cost: 12 })
})

it('includes temporary blocked positions in a pending search hash before paths diverge', () => {
  const { nav, layout } = fixture(), start = layout.voxelIndex(5, 4, 5), goal = layout.voxelIndex(8, 4, 5)
  const a = nav.request(start, [goal]), b = nav.request(start, [goal], new Set([layout.voxelIndex(6, 4, 5)]))
  const signature = (s: typeof a) => { const values: number[] = []; s.mixState(n => values.push(n)); return values }
  expect(signature(a)).not.toEqual(signature(b))
  while (a.status === 'pending' || b.status === 'pending') nav.step(128)
  expect(a.cost).toBe(12); expect(b.cost).toBe(20)
})

it('invalidates only the tiles whose cached edges read a changed voxel', () => {
  const { nav } = fixture()
  nav.invalidate(24, 8, 24)
  expect([...nav.revisions].filter(r => r).length).toBe(1)
  nav.invalidate(16, 4, 5)
  expect(nav.revisions[nav.tileOf(15, 4, 5)]).toBe(1); expect(nav.revisions[nav.tileOf(16, 4, 5)]).toBe(1)
  expect(nav.revisions[nav.tileOf(0, 4, 16)]).toBe(0)
})
function enclosed(side = 128) {
  const f = fixture(side)
  for (let x = 98; x <= 102; x++) for (let z = 98; z <= 102; z++) if (x === 98 || x === 102 || z === 98 || z === 102) for (let y = 4; y < 8; y++) f.blocked.add(f.layout.voxelIndex(x, y, z))
  return f
}
it('does not starve a short search behind long unreachable ones', () => {
  const { nav, layout } = enclosed()
  for (let i = 0; i < 4; i++) nav.request(layout.voxelIndex(5 + i * 2, 4, 5), [layout.voxelIndex(100, 4, 100)])
  const short = nav.request(layout.voxelIndex(5, 4, 20), [layout.voxelIndex(8, 4, 20)])
  for (let tick = 0; tick < 3 && short.status === 'pending'; tick++) nav.step(4096)
  expect(short.result()).toMatchObject({ status: 'found', cost: 12 })
})
it('spends a bounded number of operations per discovered node in an exhaustive search', () => {
  const { nav, layout } = enclosed()
  const s = nav.request(layout.voxelIndex(5, 4, 5), [layout.voxelIndex(100, 4, 100)])
  let ops = 0
  while (s.status === 'pending') { nav.step(4096); ops += nav.visited }
  expect(s.status).toBe('unreachable')
  expect(ops).toBeLessThan(16384 * 6)
})
it('accepts any pose matching a predicate when no explicit goal is given', () => {
  const { nav, layout } = fixture()
  const s = nav.request(layout.voxelIndex(5, 4, 5), [], undefined, { accept: p => layout.voxelCoords(p)[0] >= 9 })
  while (s.status === 'pending') nav.step(128)
  expect(s.result()).toMatchObject({ status: 'found', cost: 16 })
})
it('a region-confined search never leaves its tile and ends limited, not unreachable, when the goal needs a detour outside', () => {
  const { nav, layout, blocked } = fixture()
  // A wall inside tile 0 with its only gap outside the tile.
  for (let z = 0; z <= 16; z++) for (let y = 4; y < 8; y++) blocked.add(layout.voxelIndex(8, y, z))
  const start = layout.voxelIndex(4, 4, 4), goal = layout.voxelIndex(12, 4, 4), region = nav.tileOfPose(start)
  const s = nav.request(start, [goal], undefined, { region })
  while (s.status === 'pending') nav.step(128)
  expect(s.status).toBe('limited')
  expect([...s.seen.keys()]).toEqual([region])
  const free = nav.request(start, [goal])
  while (free.status === 'pending') nav.step(128)
  expect(free.status).toBe('found')
  const inside = nav.request(start, [layout.voxelIndex(4, 4, 12)], undefined, { region })
  while (inside.status === 'pending') nav.step(128)
  expect(inside.result()).toMatchObject({ status: 'found', cost: 32 })
})
it('a region-confined search with no way out of its own enclosure is still limited only when it was cut', () => {
  const { nav, layout, blocked } = fixture()
  for (let x = 2; x <= 6; x++) for (let z = 2; z <= 6; z++) if (x === 2 || x === 6 || z === 2 || z === 6) for (let y = 4; y < 8; y++) blocked.add(layout.voxelIndex(x, y, z))
  const s = nav.request(layout.voxelIndex(4, 4, 4), [layout.voxelIndex(10, 4, 10)], undefined, { region: 0 })
  while (s.status === 'pending') nav.step(128)
  expect(s.status).toBe('unreachable')
})
it('schedules route searches with flat ones inside one budget and keeps short searches fast', () => {
  const { nav, layout } = fixture(256)
  const long = nav.route(layout.voxelIndex(2, 4, 2), [layout.voxelIndex(250, 4, 250)])
  const short = nav.request(layout.voxelIndex(5, 4, 20), [layout.voxelIndex(8, 4, 20)])
  for (let tick = 0; tick < 3 && short.status === 'pending'; tick++) { nav.step(4096); expect(nav.visited).toBeLessThanOrEqual(4096) }
  expect(short.status).toBe('found')
  while (long.status === 'pending') { nav.step(4096); expect(nav.visited).toBeLessThanOrEqual(4096) }
  expect(long.status).toBe('found')
  expect(nav.bytes).toBeGreaterThan(nav.regions.bytes)
  expect(nav.regions.size).toBeGreaterThan(0)
})
it('schedules group fields and cancels abstract queries only on geometry, never on policy', () => {
  const { nav, layout } = fixture(128)
  const g = nav.group([layout.voxelIndex(120, 4, 120)], [layout.voxelIndex(4, 4, 4), layout.voxelIndex(8, 4, 4)])
  const r = nav.route(layout.voxelIndex(4, 4, 4), [layout.voxelIndex(120, 4, 120)])
  nav.step(4096); nav.invalidatePolicy()
  expect(g.status).toBe('pending'); expect(r.status).toBe('pending')
  while (g.status === 'pending' || r.status === 'pending') { nav.step(4096); expect(nav.visited).toBeLessThanOrEqual(4096) }
  expect(g.status).toBe('found'); expect(g.next(layout.voxelIndex(4, 4, 4))!.cost).toBe(r.cost)
  expect(nav.explored(r, [4, 4, 4], [4, 4, 4])).toBe(true)
})
it('mixes the kind of each query', () => {
  const { nav, layout } = fixture(64)
  const sig = () => { const v: number[] = []; nav.mixState(n => v.push(n)); return v }
  nav.request(layout.voxelIndex(2, 4, 2), [layout.voxelIndex(60, 4, 60)]); const a = sig()
  nav.reset(); nav.route(layout.voxelIndex(2, 4, 2), [layout.voxelIndex(60, 4, 60)]); const b = sig()
  expect(a).not.toEqual(b)
})
it('reset drops region records and cancels routes', () => {
  const { nav, layout } = fixture(128)
  const r = nav.route(layout.voxelIndex(2, 4, 2), [layout.voxelIndex(120, 4, 120)]); nav.step(8192)
  nav.reset()
  expect(r.status).toBe('cancelled'); expect(nav.regions.size).toBe(0)
})
it('marks an exhausted engineering search as limited when a viable detour exits its radius', () => {
  const { nav, layout, blocked } = fixture(32)
  for (let z = 4; z <= 20; z++) for (let y = 4; y <= 7; y++) blocked.add(layout.voxelIndex(13, y, z))
  expect(finish(nav, layout.voxelIndex(12, 4, 12), layout.voxelIndex(14, 4, 12), 128)).toMatchObject({ status: 'found', cost: 80 })
  const s = new EngineeringSearch({ layout, get: nav.port.get, solid: v => v !== 0, digTicks: () => 0, buildTicks: 0, capacityRemaining: 0, drop: () => 0, safe: () => true }, [12, 4, 12], [14, 4, 12], 0, 0)
  while (s.status === 'pending') expect(s.step(32)).toBeLessThanOrEqual(32)
  expect(s.status).toBe('limited')
})
it('prebuilds regions with spare operations: rings around anchors first, then every tile by index, within the cap', () => {
  const layout = new Layout([128, 32, 128]), registry = new BlockRegistry([{ name: 'stone' }])
  const nav = new NavigationSystem({ layout, registry, get: (x, y) => y < 4 ? 1 : 0 })
  const anchor = nav.tileOf(100, 4, 100), order: number[] = []
  const put = nav.regions.put.bind(nav.regions)
  nav.regions.put = r => { order.push(r.index); put(r) }
  for (let tick = 0; tick < 2000 && !nav.prebuilt; tick++) expect(nav.prebuild(512, [anchor])).toBeLessThanOrEqual(512)
  expect(nav.prebuilt).toBe(true)
  expect(nav.regions.size).toBe(nav.revisions.length)
  // The anchor's tile first, then its 3 × 3 ring, before any tile by index.
  expect(order[0]).toBe(anchor)
  const ring = (t: number) => Math.max(Math.abs((t % 8) - (anchor % 8)), Math.abs((Math.floor(t / 8) % 8) - (Math.floor(anchor / 8) % 8)))
  expect(order.slice(0, 9).every(t => ring(t) <= 1)).toBe(true)
  // Once everything is built, a pass costs one operation per tile checked and builds nothing.
  const size = nav.regions.bytes
  nav.prebuild(512, [anchor])
  expect(nav.regions.bytes).toBe(size)
})
it('prebuild rebuilds a tile an edit invalidated and stops short of the store cap', () => {
  const layout = new Layout([128, 32, 128]), registry = new BlockRegistry([{ name: 'stone' }])
  const nav = new NavigationSystem({ layout, registry, get: (x, y) => y < 4 ? 1 : 0 })
  while (!nav.prebuilt) nav.prebuild(4096, [])
  nav.invalidate(40, 4, 40)
  const t = nav.tileOf(40, 4, 40)
  expect(nav.regions.get(t)).toBeUndefined()
  for (let i = 0; i < 100 && !nav.regions.get(t); i++) nav.prebuild(4096, [])
  expect(nav.regions.get(t)).toBeDefined()
  // A store near its cap is not churned: prebuild stops instead of evicting what it built.
  const capped = new NavigationSystem({ layout, registry, get: (x, y) => y < 4 ? 1 : 0 }, 16384, 512, 40_000)
  let puts = 0
  const put = capped.regions.put.bind(capped.regions)
  capped.regions.put = r => { puts++; put(r) }
  for (let i = 0; i < 200; i++) capped.prebuild(4096, [])
  const settled = puts
  for (let i = 0; i < 200; i++) capped.prebuild(4096, [])
  expect(puts).toBe(settled)
  expect(capped.regions.size).toBeLessThan(capped.revisions.length)
})
it('reports prebuild progress: every tile built once, or stopped by the store cap', () => {
  const layout = new Layout([128, 32, 128]), registry = new BlockRegistry([{ name: 'stone' }])
  const nav = new NavigationSystem({ layout, registry, get: (x, y) => y < 4 ? 1 : 0 })
  const tiles = nav.revisions.length
  expect(nav.prebuildStatus()).toEqual({ built: 0, ground: tiles, queued: tiles, bytes: 0, capBytes: 64 * 1024 * 1024, done: false })
  nav.prebuild(4096, [])
  const partway = nav.prebuildStatus()
  expect(partway.built).toBeGreaterThan(0); expect(partway.built + partway.queued).toBe(tiles); expect(partway.done).toBe(false)
  while (!nav.prebuildStatus().done) nav.prebuild(4096, [])
  expect(nav.prebuildStatus()).toMatchObject({ built: tiles, ground: tiles, queued: 0, bytes: nav.regions.bytes, done: true })
  // An edit leaves the world warm: its tile is rebuilt in the background, but every tile was built once.
  nav.invalidate(40, 4, 40)
  expect(nav.prebuildStatus()).toMatchObject({ built: tiles, done: true })
  // A store too small for the world: done once the prebuild stops short of the cap, with tiles never built.
  const capped = new NavigationSystem({ layout, registry, get: (x, y) => y < 4 ? 1 : 0 }, 16384, 512, 40_000)
  for (let i = 0; i < 200 && !capped.prebuildStatus().done; i++) capped.prebuild(4096, [])
  const s = capped.prebuildStatus()
  expect(s.done).toBe(true); expect(s.built).toBeLessThan(s.ground); expect(s.capBytes).toBe(40_000)
})
it('finishes builds that queries or refinement left unfinished before anything else, so none lingers half built', () => {
  const layout = new Layout([128, 32, 128]), registry = new BlockRegistry([{ name: 'stone' }])
  const nav = new NavigationSystem({ layout, registry, get: (x, y) => y < 4 ? 1 : 0 })
  // A route search starts building its start tile, then is cancelled: the half-built job stays shared, not wasted.
  const route = nav.route(layout.voxelIndex(100, 4, 100), [layout.voxelIndex(10, 4, 10)]), t = nav.tileOf(100, 4, 100)
  route.step(8); route.cancel()
  expect(nav.building.has(t)).toBe(true)
  // A refinement build on another tile, left after one slice.
  const u = nav.tileOf(70, 4, 20)
  expect(nav.regionNow(u, 8).region).toBeUndefined()
  // The prebuild's cursor starts at tile 0 with no anchors, yet both jobs are finished first.
  const put = nav.regions.put.bind(nav.regions), order: number[] = []
  nav.regions.put = r => { order.push(r.index); put(r) }
  while (nav.building.size) nav.prebuild(256, [])
  expect(order.slice(0, 2)).toEqual([t, u])
})
