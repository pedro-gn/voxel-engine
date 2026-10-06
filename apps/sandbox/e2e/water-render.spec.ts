import { expect, test } from '@playwright/test'
import type { Engine } from '@elovox/engine'

type W = Window & { __elovox?: { engine: Engine; ready: boolean } }

test('the flood scene draws its lake and sea as heightfield water, with no console errors', async ({ page }) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/?scene=flood')
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 120_000 })
  await page.waitForFunction(() => {
    const water = (window as W).__elovox!.engine.scene.getObjectByName('elovox-water')
    return !!water && water.children.length > 0
  }, null, { timeout: 30_000 })
  // The lake starts asleep, so only the first publish after generation (every tile once) brings it to the main thread:
  // column (60, 60) of chunk column 1 + 1 × 8 (draw layer 0) is drawn at the lake's surface (25 blocks), not dry at y = 0.
  const lake = await page.evaluate(() => {
    const mesh = (window as W).__elovox!.engine.scene.getObjectByName('water-0-9') as unknown as {
      geometry: { getAttribute(name: string): { array: Float32Array } }
    } | undefined
    if (!mesh) return null
    const o = (28 + 28 * 32) * 4
    return { h: [...mesh.geometry.getAttribute('hCur').array.subarray(o, o + 4)], packed: mesh.geometry.getAttribute('info').array[o + 3]! }
  })
  expect(lake).not.toBeNull()
  expect(lake!.packed).toBeGreaterThanOrEqual(0)
  for (const h of lake!.h) expect(Math.abs(h - 25)).toBeLessThan(0.5)
  await page.waitForTimeout(3000) // a few frames with the water shaders compiled and drawing
  // The main thread's water apply cost is measured (the first publish was applied above) and shown on the HUD.
  const stats = await page.evaluate(() => (window as W).__elovox!.engine.stats())
  expect(stats.waterApplyMs).toBeGreaterThanOrEqual(0)
  expect(stats.waterApplyP95).toBeGreaterThan(0)
  expect(await page.locator('#hud').textContent()).toMatch(/water apply \d+\.\d\d ms \(p95 \d+\.\d\d\)/)
  expect(errors).toEqual([])
})
