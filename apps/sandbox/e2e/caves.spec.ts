import { expect, test, type Page } from '@playwright/test'
import type { Engine } from '@elovox/engine'

type Caves = { digTunnel(): void; pierceRoof(): void; openDam(): void; openCanal(): void }
type W = Window & { __elovox?: { engine: Engine; caves: Caves | null; ready: boolean } }

async function open(page: Page): Promise<string[]> {
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/?scene=caves')
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 120_000 })
  return errors
}

/** Whether voxel (x, y, z) holds water. */
function wet(page: Page, x: number, y: number, z: number): Promise<boolean> {
  return page.evaluate(([x, y, z]) => {
    const e = (window as W).__elovox!.engine
    return (e.world.get(x!, y!, z!) & 0xfff) === e.blocks.id('water')
  }, [x, y, z])
}

test('the pierced roof pours the pond into the cave; the dam hole drains into the valley; the tunnel lifts the shaft', async ({ page }) => {
  test.setTimeout(300_000)
  const errors = await open(page)
  expect(await wet(page, 80, 18, 15)).toBe(false)
  await page.evaluate(() => { const c = (window as W).__elovox!.caves!; c.pierceRoof(); c.openDam(); c.digTunnel() })
  await page.waitForFunction(() => {
    const e = (window as W).__elovox!.engine, water = e.blocks.id('water')
    return (e.world.get(80, 18, 15) & 0xfff) === water
  }, null, { timeout: 180_000, polling: 1000 })
  await page.waitForFunction(() => {
    const e = (window as W).__elovox!.engine, water = e.blocks.id('water')
    for (let x = 20; x <= 40; x++) if ((e.world.get(x, 10, 50) & 0xfff) === water) return true
    return false
  }, null, { timeout: 180_000, polling: 1000 })
  await page.waitForFunction(() => {
    const e = (window as W).__elovox!.engine
    return (e.world.get(80, 25, 27) & 0xfff) === e.blocks.id('water') // above the tunnel's roof: pressure lifted it
  }, null, { timeout: 180_000, polling: 1000 })
  expect(errors).toEqual([])
})
