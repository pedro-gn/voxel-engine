import { expect, test, type Page } from '@playwright/test'
import type { Engine } from '@elovox/engine'

interface WanderStats { units: number; dug: number; built: number; died: number }
type W = Window & { __elovox?: { engine: Engine; ready: boolean; sky: { stats: WanderStats | null } | null } }

/** Waits until every queued chunk is meshed and uploaded, then a few frames. */
async function settled(page: Page): Promise<void> {
  await page.waitForFunction(() => { const s = (window as W).__elovox!.engine.stats(); return s.meshQueue === 0 && s.meshInFlight === 0 }, null, { timeout: 60_000 })
  await page.waitForTimeout(500)
}
async function shot(page: Page, testInfo: { outputPath(n: string): string; attach(n: string, o: { path: string; contentType: string }): Promise<void> }, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`)
  await page.locator('canvas').screenshot({ path })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

test('the sky scene: a void-world island run by a game system, cut by layers, at any time of day', async ({ page }, testInfo) => {
  test.setTimeout(300_000)
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/?scene=sky')
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 120_000 })
  await settled(page)
  expect(await page.evaluate(() => (window as W).__elovox!.engine.voidWorld)).toBe(true)

  // The wander system spawned its three controlled units and digs within a minute of sim time.
  await page.waitForFunction(() => (window as W).__elovox!.sky?.stats?.units === 3, null, { timeout: 30_000 })
  await page.waitForFunction(() => ((window as W).__elovox!.sky?.stats?.dug ?? 0) >= 1, null, { timeout: 60_000 })
  expect((await page.evaluate(() => (window as W).__elovox!.sky!.stats))!.died).toBe(0)

  // Nothing pools under the island: no liquid voxel anywhere below its underside.
  const wet = await page.evaluate(() => {
    const e = (window as W).__elovox!.engine, [sx, , sz] = e.layout.size
    let n = 0
    for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) for (let y = 0; y < 15; y++) if (e.blocks.liquid[e.world.get(x, y, z) & 0xfff]) n++
    return n
  })
  expect(wet).toBe(0)
  await shot(page, testInfo, 'sky-surface')

  // The layer cut: the island drawn below layer 40, picking through what it hides.
  await page.evaluate(() => (window as W).__elovox!.engine.view.cut(40))
  await settled(page)
  expect(await page.evaluate(() => (window as W).__elovox!.engine.view.cutY)).toBe(40)
  const hit = await page.evaluate(() => (window as W).__elovox!.engine.raycast({ x: 128.5, y: 95, z: 120.5 }, { x: 0, y: -1, z: 0 }, 200))
  expect(hit).not.toBeNull()
  expect(hit!.pos[1]).toBeLessThanOrEqual(40)
  await shot(page, testInfo, 'sky-cut-40')
  await page.evaluate(() => (window as W).__elovox!.engine.view.cut(null))
  await settled(page)
  const top = await page.evaluate(() => (window as W).__elovox!.engine.raycast({ x: 128.5, y: 95, z: 120.5 }, { x: 0, y: -1, z: 0 }, 200))
  expect(top!.pos[1]).toBeGreaterThan(40)

  // The time of day: night, dawn, noon.
  for (const [t, name] of [[0, 'night'], [0.26, 'dawn'], [0.5, 'noon']] as const) {
    await page.evaluate((t) => (window as W).__elovox!.engine.atmosphere.setTimeOfDay(t), t)
    await page.waitForTimeout(400)
    expect(await page.evaluate(() => (window as W).__elovox!.engine.atmosphere.timeOfDay)).toBeCloseTo(t)
    await shot(page, testInfo, `sky-${name}`)
  }

  // The management camera turns back to its home yaw (0.7, the scene's option), the short way round.
  const yaw = await page.evaluate(() => {
    const c = (window as W).__elovox!.engine.controls
    c.goal.yaw += 7; c.current.yaw = c.goal.yaw
    c.reset()
    return c.goal.yaw
  })
  expect(Math.abs(Math.sin((yaw - 0.7) / 2))).toBeLessThan(1e-9)
  expect(errors).toEqual([])
})
