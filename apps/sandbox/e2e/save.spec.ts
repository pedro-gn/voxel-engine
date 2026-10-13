import { expect, test, type Page } from '@playwright/test'
import type { Engine, SaveResult } from '@elovox/engine'
import type { Living } from '../src/livingScript.ts'

type W = Window & { __elovox?: { engine: Engine; living: Living | null; ready: boolean; save(slot: string): Promise<SaveResult> } }
const ready = (page: Page) => page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 300_000 })
const clear = (page: Page) => page.evaluate(async () => {
  const root = await navigator.storage.getDirectory()
  try { await root.removeEntry('elovox-saves', { recursive: true }) } catch { /* none yet */ }
})

test('living: save, reload from the save, and continue', async ({ page }) => {
  test.setTimeout(600_000)
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto('/?scene=living'); await ready(page); await clear(page)
  await page.evaluate(() => (window as W).__elovox!.living!.startWork())
  await page.waitForFunction(() => (window as W).__elovox!.engine.workers?.orders.some(o => o.done > 0) ?? false, null, { timeout: 120_000 })
  const progress = () => page.evaluate(() => Object.fromEntries((window as W).__elovox!.engine.workers!.orders.map(o => [o.id, o.done])))
  const tick0 = await page.evaluate(() => (window as W).__elovox!.engine.stats().tick)
  const done0 = await progress()
  const first = await page.evaluate(() => (window as W).__elovox!.save('e2e-living'))
  expect(first.regionsWritten).toBe(4) // 512² is 4 save regions, all new
  const before = await page.evaluate(() => { const e = (window as W).__elovox!.engine; return { tick: e.stats().tick, units: e.workers!.stats.units } })

  await page.goto('/?save=e2e-living'); await ready(page)
  const after = await page.evaluate(() => { const e = (window as W).__elovox!.engine; return { tick: e.stats().tick, saved: e.restored!.manifest.tick, slot: e.restored?.slot, app: e.restored?.app as { scene: string; scripts: { living?: { started: boolean } } } } })
  expect(after.slot).toBe('e2e-living')
  expect(after.app.scene).toBe('living')
  expect(after.app.scripts.living?.started).toBe(true)
  // The save holds a tick between the call and its answer, and the loaded world starts there.
  expect(after.saved).toBeGreaterThanOrEqual(tick0)
  expect(after.saved).toBeLessThanOrEqual(before.tick)
  expect(after.tick).toBeGreaterThanOrEqual(after.saved)
  await page.waitForFunction((n) => (window as W).__elovox!.engine.workers?.stats.units === n, before.units, { timeout: 60_000 })
  // Work continues from where it was: every saved order is at least as far as before the save, and work moves on.
  const loaded = await progress()
  for (const [id, done] of Object.entries(done0)) expect(loaded[id]).toBeGreaterThanOrEqual(done)
  await page.waitForFunction((d) => (window as W).__elovox!.engine.workers!.orders.some(o => o.done > (d[o.id] ?? 0)), loaded, { timeout: 120_000 })
  expect(errors).toEqual([])
})

test('a save of an unchanged world after a load copies and writes nothing new', async ({ page }) => {
  test.setTimeout(300_000)
  // ?still: no physics and no random ticks, so nothing writes between the saves (the living scene touches every region every few ticks).
  await page.goto('/?scene=terrain&size=256&still'); await ready(page); await clear(page)
  expect((await page.evaluate(() => (window as W).__elovox!.save('e2e-still'))).regionsWritten).toBe(1)
  await page.goto('/?save=e2e-still&still'); await ready(page)
  const again = await page.evaluate(() => (window as W).__elovox!.save('e2e-still'))
  expect(again.regionsWritten).toBe(0)
  expect(again.blobsWritten).toBeLessThanOrEqual(1) // at most the app section (the camera)
})

test('autosave rotates slots on a short interval', async ({ page }) => {
  test.setTimeout(300_000)
  await page.goto('/?scene=flood&autosaveMs=3000'); await ready(page); await clear(page)
  await page.waitForFunction(async () => {
    const s = await (window as W).__elovox!.engine.saves.list()
    return s.some(x => x.slot === 'autosave-1') && s.some(x => x.slot === 'autosave-2')
  }, null, { timeout: 60_000, polling: 1000 })
})

test('a corrupted save is refused with its message', async ({ page }) => {
  test.setTimeout(300_000)
  await page.goto('/?scene=flood'); await ready(page); await clear(page)
  await page.evaluate(() => (window as W).__elovox!.save('broken'))
  await page.evaluate(async () => {
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('elovox-saves')).getDirectoryHandle('blobs')
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
      const w = await (await dir.getFileHandle(name)).createWritable(); await w.write(new Uint8Array([1, 2, 3])); await w.close(); break
    }
  })
  await page.goto('/?save=broken')
  await expect(page.getByText(/does not match its hash|is missing from the store/)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('Start the scene fresh')).toBeVisible()
})
