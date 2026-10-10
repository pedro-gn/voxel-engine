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
