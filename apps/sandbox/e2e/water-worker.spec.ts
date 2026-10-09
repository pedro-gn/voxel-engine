import { expect, test, type Page } from '@playwright/test'
import type { Engine } from '@elovox/engine'

// 4a-r2 #2: the water host in its worker (default) and in-thread (?nowaterworker); a lost worker is respawned once.
type Flood = { breach(): void; stopSpring(): void }
type W = Window & { __elovox?: { engine: Engine; flood: Flood | null; ready: boolean } }

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

async function openAndBreach(page: Page, query = ''): Promise<void> {
  await page.goto(`/?scene=flood${query}`)
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 120_000 })
  await page.evaluate(() => { const f = (window as W).__elovox!.flood!; f.stopSpring(); f.breach() })
}

/** Calls the engine's internal crash hook (symbol-keyed, not on the Engine type). */
async function crashWaterWorker(page: Page): Promise<void> {
  await page.evaluate(() => {
    const e = (window as W).__elovox!.engine as unknown as Record<symbol, () => void>
    e[Symbol.for('elovox.waterCrash')]!()
  })
}

test('the water runs in its worker, survives one lost worker, and a second loss is fatal', async ({ page }) => {
  test.setTimeout(300_000)
  const errors = watchErrors(page)
  await openAndBreach(page)
  await page.waitForFunction(() => { const s = (window as W).__elovox!.engine.stats(); return s.waterHostP95 > 0 && s.waterLagP95 > 0 && s.waterApplyP95 > 0 }, null, { timeout: 120_000, polling: 500 })
  const before = await page.evaluate(() => (window as W).__elovox!.engine.stats())
  expect(before.waterInWorker).toBe(true)
  // A slow main thread (headless SwiftShader draws ~1 frame/s) lets ticks bunch up; the queue must still drain.
  await page.waitForFunction(() => (window as W).__elovox!.engine.stats().waterQueue <= 1, null, { timeout: 60_000, polling: 100 })

  await crashWaterWorker(page)
  // The respawned worker answers again: new host samples come in and the water is still drawn.
  await page.waitForFunction((n) => { const s = (window as W).__elovox!.engine.stats(); return s.waterColumns > 0 && s.waterHostMs !== n }, before.waterHostMs, { timeout: 60_000, polling: 250 })
  await page.waitForTimeout(2000)
  expect(errors.filter(e => !e.includes('[elovox] water worker lost'))).toEqual([])
  expect(errors.filter(e => e.includes('[elovox] water worker lost')).length).toBe(1)

  const fatal = page.evaluate(() => new Promise<string>(res => { (window as W).__elovox!.engine.on('fatal', f => res(f.message)) }))
  await crashWaterWorker(page)
  expect(await fatal).toContain('water worker crashed twice')
})

test('?nowaterworker: the same water, applied in-thread', async ({ page }) => {
  test.setTimeout(300_000)
  const errors = watchErrors(page)
  await openAndBreach(page, '&nowaterworker')
  await page.waitForFunction(() => (window as W).__elovox!.engine.stats().waterApplyP95 > 0, null, { timeout: 120_000, polling: 500 })
  const s = await page.evaluate(() => (window as W).__elovox!.engine.stats())
  expect(s.waterInWorker).toBe(false)
  expect(s.waterColumns).toBeGreaterThan(0)
  expect(errors).toEqual([])
})

test('dispose while the water worker has a request in flight leaves no errors', async ({ page }) => {
  test.setTimeout(300_000)
  const errors = watchErrors(page)
  await openAndBreach(page)
  await page.waitForFunction(() => (window as W).__elovox!.engine.stats().waterHostP95 > 0, null, { timeout: 120_000, polling: 500 })
  await page.evaluate(() => (window as W).__elovox!.engine.dispose())
  await page.waitForTimeout(2000)
  expect(errors).toEqual([])
})
