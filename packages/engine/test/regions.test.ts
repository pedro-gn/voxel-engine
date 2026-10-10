import { expect, it } from 'vitest'
import { NavigationSystem } from '../src/sim/navigation/navigation.ts'
import { BUILD_WEIGHT, RegionBuild, RegionStore, UNREACHED, exitCosts, reverseField } from '../src/sim/navigation/regions.ts'
import { BlockRegistry } from '../src/blocks/registry.ts'
import { Layout } from '../src/world/layout.ts'

function fixture(side = 64, solid = new Set<number>()) {
  const layout = new Layout([side, 32, side]), registry = new BlockRegistry([{ name: 'stone' }])
  const nav = new NavigationSystem({ layout, registry, get: (x, y, z) => y < 4 || solid.has(layout.voxelIndex(x, y, z)) ? 1 : 0 })
  return { nav, layout, solid }
}
function build(nav: NavigationSystem, index: number, cap = 64) {
  const b = new RegionBuild(nav, index)
  while (!b.done) expect(b.step(cap)).toBeLessThanOrEqual(cap)
  return b.result()
}

it('an open floor region has 256 poses and exits on its four sides in runs of at most 8', () => {
  const { nav, layout } = fixture()
  const r = build(nav, nav.tileOf(16, 4, 16))
  expect(r.poses.length).toBe(256)
  // 4 sides × 16 crossings / 8 per run = 8 exits
  expect(r.exits).toHaveLength(8)
  for (const e of r.exits) { expect(nav.tileOfPose(e.to)).not.toBe(r.index); expect(nav.tileOfPose(e.from)).toBe(r.index); expect(e.cost).toBe(4) }
  // The corner pose reaches every exit; the field agrees with flat distances.
  const corner = layout.voxelIndex(16, 4, 16), costs = exitCosts(r, corner, layout)
  expect(costs.every(c => c !== UNREACHED)).toBe(true)
  r.exits.forEach((e, i) => { const [x, , z] = layout.voxelCoords(e.from); expect(costs[i]).toBe((x - 16 + z - 16) * 4) })
})
it('crossings whose heights alternate by one block still join into runs of 8 when they step to each other', () => {
  const { nav, layout, solid } = fixture()
  for (let x = 0; x < 64; x++) for (let z = 1; z < 64; z += 2) solid.add(layout.voxelIndex(x, 4, z))
  const r = build(nav, nav.tileOf(16, 4, 16))
  expect(r.poses.length).toBe(256)
  expect(r.exits).toHaveLength(8)
  // A ledge two blocks high cannot be climbed: its crossings stay apart from the floor's.
  for (let x = 0; x < 64; x++) for (let y = 4; y < 7; y++) solid.add(layout.voxelIndex(x, y, 20))
  nav.invalidateBox(0, 4, 20, 63, 6, 20)
  const s = build(nav, nav.tileOf(16, 4, 16))
  expect(s.exits.length).toBeGreaterThan(8)
})
it('a drop is a one-way exit: the lower region has no exit back up the cliff', () => {
  const { nav, layout, solid } = fixture()
  // Upper shelf x < 16 at y=4..5 (top at 6), lower floor x >= 16 at y=4.
  for (let x = 0; x < 16; x++) for (let z = 0; z < 32; z++) for (let y = 4; y < 6; y++) solid.add(layout.voxelIndex(x, y, z))
  nav.invalidateBox(0, 0, 0, 31, 8, 31)
  const upper = build(nav, nav.tileOf(8, 6, 8)), lower = build(nav, nav.tileOf(20, 4, 8))
  expect(upper.exits.some(e => nav.tileOfPose(e.to) === lower.index)).toBe(true)
  expect(lower.exits.some(e => nav.tileOfPose(e.to) === upper.index)).toBe(false)
  expect(upper.exits.filter(e => e.target === lower.index).every(e => e.cost === 6)).toBe(true)
})
it('the store returns a region only while its tile revision is unchanged and evicts past its byte cap', () => {
  const { nav } = fixture(128)
  const store = new RegionStore(nav, 64 * 1024)
  const a = build(nav, nav.tileOf(0, 4, 0)); store.put(a)
  expect(store.get(a.index)).toBe(a)
  nav.invalidate(3, 4, 3)
  expect(store.get(a.index)).toBeUndefined()
  for (let i = 0; i < 16; i++) store.put(build(nav, nav.tileOf(i * 16 % 128, 4, Math.floor(i / 8) * 16)))
  expect(store.bytes).toBeLessThanOrEqual(64 * 1024)
  expect(store.size).toBeGreaterThan(0)
  store.clear(); expect(store.size).toBe(0); expect(store.bytes).toBe(0)
})
it('builds are sliceable and give the same region at any slice size', () => {
  const { nav } = fixture()
  const a = build(nav, nav.tileOf(16, 4, 16), 7), b = build(nav, nav.tileOf(16, 4, 16), 5000)
  expect([...a.fields]).toEqual([...b.fields]); expect(a.exits).toEqual(b.exits)
})
it('a build restarts when its tile changes mid-build and yields the new geometry', () => {
  const { nav, layout, solid } = fixture()
  const b = new RegionBuild(nav, nav.tileOf(16, 4, 16))
  b.step(3000)
  solid.add(layout.voxelIndex(20, 4, 20)); nav.invalidate(20, 4, 20)
  while (!b.done) b.step(512)
  const r = b.result()
  expect(r.epoch).toBe(nav.revisions[r.index]); expect(r.slots[4 + (4 << 4) + (4 << 8)]).toBe(-1); expect(r.slots[4 + (4 << 4) + (5 << 8)]).toBeGreaterThanOrEqual(0)
})
it('a reverse field from a goal pose agrees with flat costs and marks other regions unreached', () => {
  const { nav, layout } = fixture()
  const r = build(nav, nav.tileOf(16, 4, 16)), goal = layout.voxelIndex(20, 4, 24)
  const f = reverseField(r, [goal, layout.voxelIndex(40, 4, 40)], layout)
  expect(f[r.slots[4 + (8 << 4) + (4 << 8)]!]).toBe(0)
  expect(f[r.slots[4 << 8]!]).toBe((4 + 8) * 4)
})
it('a walled-off pocket inside a region cannot reach the exits', () => {
  const { nav, layout, solid } = fixture()
  for (let x = 18; x <= 22; x++) for (let z = 18; z <= 22; z++) if (x === 18 || x === 22 || z === 18 || z === 22) for (let y = 4; y < 8; y++) solid.add(layout.voxelIndex(x, y, z))
  const r = build(nav, nav.tileOf(16, 4, 16))
  expect(exitCosts(r, layout.voxelIndex(20, 4, 20), layout).every(c => c === UNREACHED)).toBe(true)
  expect(exitCosts(r, layout.voxelIndex(16, 4, 16), layout).every(c => c !== UNREACHED)).toBe(true)
})
it('poses standing on a falling block are not region poses: a sand strip splits a floor with no exit across it', () => {
  const layout = new Layout([64, 32, 64]), registry = new BlockRegistry([{ name: 'stone' }, { name: 'sand', falls: true }])
  const nav = new NavigationSystem({ layout, registry, get: (x, y, z) => y < 3 ? 1 : y === 3 ? (x >= 20 && x <= 22 ? 2 : 1) : 0 })
  const r = build(nav, nav.tileOf(16, 4, 16))
  expect(nav.stand(21, 4, 20)).toBe(true); expect(nav.regionStand(21, 4, 20)).toBe(false)
  expect(r.poses.length).toBe(256 - 3 * 16)
  for (const e of r.exits) { const [x] = layout.voxelCoords(e.from), [tx] = layout.voxelCoords(e.to); expect(x < 20 === tx < 20).toBe(true) }
  // Cells west of the strip cannot reach the east part inside the region.
  const west = exitCosts(r, layout.voxelIndex(17, 4, 20), layout)
  r.exits.forEach((e, i) => { if (layout.voxelCoords(e.from)[0] > 22) expect(west[i]).toBe(UNREACHED) })
})
it('build steps are charged at BUILD_WEIGHT per operation and counted by phase', () => {
  const { nav } = fixture()
  const b = new RegionBuild(nav, nav.tileOf(16, 4, 16))
  let charged = 0
  while (!b.done) { const used = b.step(10); expect(used).toBeLessThanOrEqual(10); charged += used }
  const steps = Object.values(b.counts).reduce((a, n) => a + n, 0)
  expect(b.counts.poses).toBeGreaterThanOrEqual(4096); expect(b.counts.fields).toBeGreaterThan(0)
  expect(charged).toBeGreaterThanOrEqual(Math.ceil(steps / BUILD_WEIGHT)); expect(charged).toBeLessThanOrEqual(Math.ceil(steps / BUILD_WEIGHT) + 1 + steps / BUILD_WEIGHT / 10)
})
