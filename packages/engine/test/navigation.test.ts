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

it('reconstructs every local step of long portal shortcuts with exact cost', () => {
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
it('marks an exhausted engineering search as limited when a viable detour exits its radius', () => {
  const { nav, layout, blocked } = fixture(32)
  for (let z = 4; z <= 20; z++) for (let y = 4; y <= 7; y++) blocked.add(layout.voxelIndex(13, y, z))
  expect(finish(nav, layout.voxelIndex(12, 4, 12), layout.voxelIndex(14, 4, 12), 128)).toMatchObject({ status: 'found', cost: 80 })
  const s = new EngineeringSearch({ layout, get: nav.port.get, solid: v => v !== 0, digTicks: () => 0, buildTicks: 0, capacityRemaining: 0, drop: () => 0, safe: () => true }, [12, 4, 12], [14, 4, 12], 0, 0)
  while (s.status === 'pending') expect(s.step(32)).toBeLessThanOrEqual(32)
  expect(s.status).toBe('limited')
})
