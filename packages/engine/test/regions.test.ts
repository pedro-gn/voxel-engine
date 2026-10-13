import { expect, it } from 'vitest'
import { NavigationSystem } from '../src/sim/navigation/navigation.ts'
import { BUILD_WEIGHT, RegionBuild, RegionStore, UNREACHED, exitCosts, reverseField, slotOf, localOf } from '../src/sim/navigation/regions.ts'
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
  expect(r.epoch).toBe(nav.revisions[r.index]); expect(slotOf(r, layout.voxelIndex(20, 4, 20), layout)).toBe(-1); expect(slotOf(r, layout.voxelIndex(20, 5, 20), layout)).toBeGreaterThanOrEqual(0)
})
it('a reverse field from a goal pose agrees with flat costs and marks other regions unreached', () => {
  const { nav, layout } = fixture()
  const r = build(nav, nav.tileOf(16, 4, 16)), goal = layout.voxelIndex(20, 4, 24)
  const f = reverseField(r, [goal, layout.voxelIndex(40, 4, 40)], layout)
  expect(f[slotOf(r, goal, layout)]).toBe(0)
  expect(f[slotOf(r, layout.voxelIndex(16, 4, 16), layout)]).toBe((4 + 8) * 4)
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
it('the column index finds the same slot as a dense cell table, and empty tiles share one frozen record', () => {
  // Hills with a cave layer: columns with several poses, steps between heights, and a fully empty upper tile.
  const layout = new Layout([64, 32, 64]), registry = new BlockRegistry([{ name: 'stone' }])
  const height = (x: number, z: number) => 4 + Math.max(0, 6 - Math.floor(Math.hypot(x - 24, z - 24) / 2))
  const nav = new NavigationSystem({ layout, registry, get: (x, y, z) => y < height(x, z) && !(y >= 1 && y <= 2 && (x + z) % 3 !== 0) ? 1 : 0 })
  let multi = 0
  for (const index of [nav.tileOf(16, 4, 16), nav.tileOf(0, 4, 0), nav.tileOf(32, 4, 16)]) {
    const r = build(nav, index), dense = new Int16Array(4096).fill(-1)
    r.poses.forEach((p, s) => { dense[localOf(layout, p)] = s })
    const [ox, oy, oz] = [(index % 4) * 16, 0, (Math.floor(index / 4) % 4) * 16]
    for (let c = 0; c < 4096; c++) expect(slotOf(r, layout.voxelIndex(ox + (c & 15), oy + (c >> 8), oz + ((c >> 4) & 15)), layout)).toBe(dense[c])
    for (let c = 0; c < 256; c++) if (r.cols[c + 1]! - r.cols[c]! > 1) multi++
    // Each exit: 48 bytes plus its crossings, two Int32 per crossing.
    const exits = r.exits.reduce((n, x) => n + 48 + x.crossings.byteLength, 0)
    expect(r.bytes).toBe(r.poses.byteLength + r.next.byteLength + r.fields.byteLength + exits + 64 + 514 + 2 * r.poses.length)
  }
  expect(multi).toBeGreaterThan(0)
  const a = build(nav, nav.tileOf(16, 20, 16)), b = build(nav, nav.tileOf(32, 20, 32))
  expect(a.poses.length).toBe(0); expect(a.bytes).toBe(64)
  expect(a.cols).toBe(b.cols); expect(a.fields).toBe(b.fields); expect(a.exits).toBe(b.exits); expect(Object.isFrozen(a.exits)).toBe(true)
})
it('a tile inside a uniform chunk with no support below builds at once, and one above a ground chunk still finds its poses', () => {
  // 64 high: chunk layer y 0..31 is dense ground (floor top at y = 3 and a solid layer 16..31 in x < 32), y 32..63 is uniform air.
  const layout = new Layout([64, 64, 64]), registry = new BlockRegistry([{ name: 'stone' }])
  const get = (x: number, y: number, z: number) => y < 4 || y < 32 && y >= 16 && x < 32 ? 1 : 0
  const uniform = (x: number, y: number, z: number) => y >= 32 ? 0 : undefined
  const nav = new NavigationSystem({ layout, registry, get, uniform })
  const charged = (index: number) => { const b = new RegionBuild(nav, index); let n = 0; do n += b.step(64); while (!b.done); return { n, r: b.result() } }
  // Upper half of the uniform air chunk: nothing can stand there.
  const high = charged(nav.tileOf(40, 48, 8))
  expect(high.r.poses.length).toBe(0); expect(high.n).toBe(1)
  // Lower half, above a solid layer in x < 32: the bottom row stands, and it is built in full.
  const low = charged(nav.tileOf(8, 32, 8)), plain = new NavigationSystem({ layout, registry, get })
  expect(low.r.poses.length).toBe(256); expect(low.r.exits).toEqual(build(plain, plain.tileOf(8, 32, 8)).exits)
  // Lower half above air (x >= 32 has no solid layer at 16..31): the dense chunk below is not uniform, so it builds.
  expect(charged(nav.tileOf(40, 32, 8)).r.poses.length).toBe(0)
})
it('an exit keeps its whole run of crossings, each with where it lands', () => {
  const { nav, layout } = fixture()
  const r = build(nav, nav.tileOf(16, 4, 16))
  // The run on the +x face (x = 31) for z = 16..23.
  const e = r.exits.findIndex(x => layout.voxelCoords(x.from)[0] === 31 && layout.voxelCoords(x.from)[2] < 24)
  const x = r.exits[e]!
  expect(x.crossings.length).toBe(16)
  for (let i = 0; i < x.crossings.length; i += 2) {
    const [fx, fy, fz] = layout.voxelCoords(x.crossings[i]!), [tx, ty, tz] = layout.voxelCoords(x.crossings[i + 1]!)
    expect([fx, fy, tx, ty, tz]).toEqual([31, 4, 32, 4, fz])
  }
  expect(x.from).toBe(x.crossings[8]); expect(x.to).toBe(x.crossings[9])
})

function wetFixture(side = 64) {
  const layout = new Layout([side, 32, side]), registry = new BlockRegistry([{ name: 'stone' }, { name: 'water', liquid: true }])
  const solid = new Set<number>(), water = new Set<number>()
  const nav = new NavigationSystem({ layout, registry, get: (x, y, z) => { const p = layout.voxelIndex(x, y, z); return y < 4 || solid.has(p) ? 1 : water.has(p) ? 2 : 0 } })
  return { nav, layout, solid, water }
}
it('a pose whose head cell holds liquid is not a region pose; a wadeable one is', () => {
  const { nav, layout, water } = wetFixture()
  // Feet-deep water at (20, 4, 20): wadeable. Head-deep at (21, 4, 20): water at y = 5 too.
  water.add(layout.voxelIndex(20, 4, 20)); water.add(layout.voxelIndex(21, 4, 20)); water.add(layout.voxelIndex(21, 5, 20))
  expect(nav.regionStand(20, 4, 20)).toBe(true)
  expect(nav.regionStand(21, 4, 20)).toBe(false)
  const r = build(nav, nav.tileOf(21, 4, 20))
  expect(r.poses).toContain(layout.voxelIndex(20, 4, 20))
  expect(r.poses).not.toContain(layout.voxelIndex(21, 4, 20))
})
it('a liquid-presence change rebuilds the tiles it touches and marks them flippy, without a geometry bump', () => {
  const { nav, layout, water } = wetFixture()
  const t = nav.tileOf(21, 4, 20), before = nav.revisions[t]!, geometry = nav.geometry
  water.add(layout.voxelIndex(21, 5, 20)); nav.invalidateLiquid(21, 5, 20)
  expect(nav.revisions[t]).toBeGreaterThan(before)
  expect(nav.flippy[t]).toBe(1)
  expect(nav.geometry).toBe(geometry)
  expect(build(nav, t).poses).not.toContain(layout.voxelIndex(21, 4, 20))
})
it('after the first pass the prebuild visits only the tiles an edit touched', () => {
  const { nav, layout, solid } = fixture(256)
  while (!nav.prebuildStatus().done) nav.prebuild(1 << 20, [])
  expect(nav.prebuild(1 << 20, [])).toBe(0)
  solid.add(layout.voxelIndex(40, 4, 40)); nav.invalidate(40, 4, 40)
  nav.prebuild(1 << 20, [])
  // The edit's footprint (x 39..41, y 2..7, z 39..41) lies in one tile; a rescan would look at all 512.
  expect(nav.prebuildChecks).toBeGreaterThan(0)
  expect(nav.prebuildChecks).toBeLessThanOrEqual(2)
  nav.prebuild(1 << 20, [])
  expect(nav.prebuildChecks).toBe(0)
})
it('a spring or a liquid other than water in the feet cell is not a region pose, as the live policy refuses it', () => {
  const layout = new Layout([64, 32, 64]), registry = new BlockRegistry([{ name: 'stone' }, { name: 'water', liquid: true }, { name: 'spring', liquid: true, source: 'water' }, { name: 'lava', liquid: true }])
  const at = new Map<number, number>()
  const nav = new NavigationSystem({ layout, registry, get: (x, y, z) => y < 4 ? 1 : at.get(layout.voxelIndex(x, y, z)) ?? 0 })
  at.set(layout.voxelIndex(20, 4, 20), 2); at.set(layout.voxelIndex(21, 4, 20), 3); at.set(layout.voxelIndex(22, 4, 20), 4)
  expect(nav.regionStand(20, 4, 20)).toBe(true) // wading in water
  expect(nav.regionStand(21, 4, 20)).toBe(false) // a spring
  expect(nav.regionStand(22, 4, 20)).toBe(false) // another liquid
})
