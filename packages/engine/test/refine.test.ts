import { expect, it } from 'vitest'
import { NavigationSystem, edgeCost } from '../src/sim/navigation/navigation.ts'
import { RegionBuild, UNREACHED, exitCosts, reverseField, slotOf } from '../src/sim/navigation/regions.ts'
import { descend } from '../src/sim/navigation/refine.ts'
import { BlockRegistry } from '../src/blocks/registry.ts'
import { Layout } from '../src/world/layout.ts'

function fixture(side = 64, solid = new Set<number>()) {
  const layout = new Layout([side, 32, side]), registry = new BlockRegistry([{ name: 'stone' }])
  const nav = new NavigationSystem({ layout, registry, get: (x, y, z) => y < 4 || solid.has(layout.voxelIndex(x, y, z)) ? 1 : 0 })
  return { nav, layout, solid }
}
function build(nav: NavigationSystem, index: number) {
  const b = new RegionBuild(nav, index)
  while (!b.done) b.step(4096)
  return b.result()
}

it('descends an exit field along an optimal path and stops at a disallowed step', () => {
  const { nav, layout } = fixture()
  const r = build(nav, nav.tileOf(16, 4, 16)), e = 0, from = layout.voxelIndex(20, 4, 26)
  const all = descend(r, e, from, () => true, layout)
  expect(all.ok).toBe(true); expect(all.path.at(-1)).toBe(r.exits[e]!.from)
  let cost = 0
  for (let i = 1; i < all.path.length; i++) cost += edgeCost(layout, all.path[i - 1]!, all.path[i]!)
  expect(cost).toBe(exitCosts(r, from, layout)[e])
  const blocked = new Set(all.path.slice(1, 2))
  const cut = descend(r, e, from, p => !blocked.has(p), layout)
  // Another optimal neighbour exists on an open floor, so descent still succeeds around one blocked pose.
  expect(cut.ok).toBe(true); expect(cut.path).not.toContain([...blocked][0])
  // With every optimal step out of the start forbidden it fails without moving.
  const none = descend(r, e, from, p => p === from, layout)
  expect(none.ok).toBe(false); expect(none.path).toEqual([from]); expect(none.ops).toBeGreaterThan(4)
})
it('descends a goal field to the goal and fails from a pose that cannot reach it', () => {
  const { nav, layout, solid } = fixture()
  for (let x = 16; x < 32; x++) for (let y = 4; y < 8; y++) solid.add(layout.voxelIndex(x, y, 24))
  const r = build(nav, nav.tileOf(16, 4, 16)), goal = layout.voxelIndex(18, 4, 18)
  const field = reverseField(r, [goal], layout)
  const d = descend(r, field, layout.voxelIndex(30, 4, 20), () => true, layout)
  expect(d.ok).toBe(true); expect(d.path.at(-1)).toBe(goal); expect(d.path).toHaveLength(15)
  const far = layout.voxelIndex(20, 4, 28)
  expect(field[slotOf(r, far, layout)]).toBe(UNREACHED)
  expect(descend(r, field, far, () => true, layout).ok).toBe(false)
})
it('given its exit, a descent heads for the exit face first and crosses at the first crossing of the run it reaches', () => {
  const { nav, layout } = fixture()
  const r = build(nav, nav.tileOf(16, 4, 16))
  // The run on the +z face (z = 31) for x = 24..31; its middle crossing is at x = 28.
  const e = r.exits.findIndex(x => layout.voxelCoords(x.from)[2] === 31 && layout.voxelCoords(x.from)[0] >= 24), x = r.exits[e]!
  expect(layout.voxelCoords(x.from)).toEqual([28, 4, 31])
  // From (25, 4, 20) the unit walks +z to the face, crossing at x = 25, not across to x = 28.
  const d = descend(r, e, layout.voxelIndex(25, 4, 20), () => true, layout, 256, x)
  expect(d.ok).toBe(true); expect(d.path.at(-1)).toBe(layout.voxelIndex(25, 4, 31)); expect(d.path).toHaveLength(12)
  // From the side of the run (x = 20) it reaches the face, then walks along it to the run's first crossing (x = 24).
  const side = descend(r, e, layout.voxelIndex(20, 4, 28), () => true, layout, 256, x)
  expect(side.ok).toBe(true); expect(side.path.at(-1)).toBe(layout.voxelIndex(24, 4, 31))
  // Without the exit it goes to the middle crossing, as before.
  expect(descend(r, e, layout.voxelIndex(25, 4, 20), () => true, layout).path.at(-1)).toBe(x.from)
})
