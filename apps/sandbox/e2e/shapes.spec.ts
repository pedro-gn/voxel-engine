import { expect, test } from '@playwright/test'
import type { Engine } from '@elovox/engine'

type W = Window & { __elovox?: { engine: Engine; ready: boolean } }

test('the shapes scene: slabs, stairs, posts and roofs mesh without errors', async ({ page }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/?scene=shapes')
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 120_000 })
  await page.waitForFunction(() => { const s = (window as W).__elovox!.engine.stats(); return s.meshQueue === 0 && s.meshInFlight === 0 }, null, { timeout: 60_000 })
  // Every shaped block of the scene is in the world, with its state (a stair facing −z, upside down).
  const stair = await page.evaluate(() => { const e = (window as W).__elovox!.engine; return e.world.get(25, 9, 6) })
  expect(stair & 0xfff).toBe(await page.evaluate(() => (window as W).__elovox!.engine.blocks.id('planks_stair')))
  expect(stair >>> 12).toBe(3 | 4)
  await page.evaluate(() => (window as W).__elovox!.engine.atmosphere.setTimeOfDay(0.4))
  await page.waitForTimeout(1500)
  await page.locator('canvas').screenshot({ path: 'test-results/shapes.png' })
  expect(errors).toEqual([])
})
