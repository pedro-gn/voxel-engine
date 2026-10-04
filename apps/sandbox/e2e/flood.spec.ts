import { expect, test, type Page } from '@playwright/test'
import type { Engine } from '@elovox/engine'

type W = Window & { __elovox?: { engine: Engine; flood: { breach(): void; drop(): void } | null; ready: boolean } }

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

/**
 * Distinct (top y : level) pairs over the lake's interior, every 3rd column (the pillar column skipped).
 * The sim worker may be mid-tick while the main thread reads, so a mixed read is retried before it counts.
 */
async function lakeSurfaces(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const e = (window as W).__elovox!.engine
    const water = e.blocks.id('water')
    let last: string[] = []
    for (let attempt = 0; attempt < 20; attempt++) {
      const seen = new Set<string>()
      for (let x = 25; x <= 124; x += 3) for (let z = 25; z <= 124; z += 3) {
        if (Math.abs(x - 70) <= 1 && Math.abs(z - 70) <= 1) continue
        for (let y = 30; y >= 20; y--) {
          const v = e.world.get(x, y, z)
          if ((v & 0xfff) === water) { seen.add(`${y}:${(v >>> 12) & 7}`); break }
        }
      }
      last = [...seen]
      if (last.length <= 1) return last
      await new Promise((r) => setTimeout(r, 30))
    }
    return last
  })
}

test('a breached lake drains flat into the valley, and sand pillars fall', async ({ page }) => {
  test.setTimeout(420_000)
  const errors = watchErrors(page)
  await page.goto('/?scene=flood')
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 120_000 })
  expect(await lakeSurfaces(page)).toEqual(['24:7'])

  await page.evaluate(() => (window as W).__elovox!.flood!.breach())
  // the lake's surface goes down: one whole level takes ~10 000 units through the breach
  await page.waitForFunction(() => {
    const e = (window as W).__elovox!.engine
    const water = e.blocks.id('water')
    for (let y = 30; y >= 20; y--) {
      const v = e.world.get(60, y, 60)
      if ((v & 0xfff) === water) return y * 8 + ((v >>> 12) & 7) < 24 * 8 + 7
    }
    return true
  }, null, { timeout: 300_000, polling: 1000 })
  const surfaces = await lakeSurfaces(page)
  expect(surfaces).toHaveLength(1) // flat
  expect(surfaces[0]).not.toBe('24:7') // and lower

  const valley = await page.evaluate(() => {
    const e = (window as W).__elovox!.engine
    const water = e.blocks.id('water')
    let n = 0
    for (let x = 126; x < 160; x++) for (let z = 50; z < 100; z++) for (let y = 9; y < 14; y++) if ((e.world.get(x, y, z) & 0xfff) === water) n++
    return n
  })
  expect(valley).toBeGreaterThan(0)

  await page.evaluate(() => (window as W).__elovox!.flood!.drop())
  await page.waitForFunction(() => {
    const e = (window as W).__elovox!.engine
    return e.world.get(60, 25, 160) === e.blocks.id('sand') && e.world.get(60, 40, 160) === 0
  }, null, { timeout: 60_000, polling: 250 })
  expect(errors).toEqual([])
})
