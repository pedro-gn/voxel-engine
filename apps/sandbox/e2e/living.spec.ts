import { expect, test } from '@playwright/test'
import type { Engine } from '@elovox/engine'
import type { Living } from '../src/livingScript.ts'
import { SITES, SITE_HALF, TOWER_BASE, UNITS, reservoirInterior } from '../src/scenes/living.ts'

type W = Window & { __elovox?: { engine: Engine; living: Living | null; ready: boolean } }

test('the living scene runs every system together: units work, the dam breaks, the tower falls', async ({ page }) => {
  test.setTimeout(600_000)
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto('/?scene=living')
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 300_000 })
  const water = await page.evaluate(() => (window as W).__elovox!.engine.blocks.id('water'))
  const inside = reservoirInterior(SITES.reservoir)
  expect(await page.evaluate(([x, y, z]) => (window as W).__elovox!.engine.world.get(x!, y!, z!) & 0xfff, [inside.min[0] + 5, inside.min[1], inside.min[2] + 5])).toBe(water)
  await page.waitForFunction((n) => (window as W).__elovox!.engine.workers?.stats.units === n, UNITS, { timeout: 60_000 })

  await page.evaluate(() => (window as W).__elovox!.living!.startWork())
  await page.waitForFunction(() => (window as W).__elovox!.engine.workers?.orders.some(o => o.done > 0) ?? false, null, { timeout: 120_000 })

  await page.evaluate(() => (window as W).__elovox!.living!.breach())
  const east = { x0: inside.max[0] + 2, x1: SITES.reservoir.x + SITE_HALF + 30, z0: inside.min[2], z1: inside.max[2], y0: SITES.reservoir.ground - 20, y1: SITES.reservoir.ground }
  await page.waitForFunction(([b, w]) => {
    const e = (window as W).__elovox!.engine
    for (let x = b.x0; x <= b.x1; x++) for (let z = b.z0; z <= b.z1; z++) for (let y = b.y0; y <= b.y1; y++) if ((e.world.get(x, y, z) & 0xfff) === w) return true
    return false
  }, [east, water] as const, { timeout: 120_000 })

  const base = TOWER_BASE(SITES.tower)
  await page.evaluate(() => (window as W).__elovox!.living!.collapse())
  await page.waitForFunction(([x, y, z]) => {
    const e = (window as W).__elovox!.engine
    return (e.world.get(x!, y!, z!) & 0xfff) === e.blocks.id('structural_planks')
  }, [base.min[0], SITES.tower.ground, base.min[2]], { timeout: 120_000 })
  expect(errors).toEqual([])
})
