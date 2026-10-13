import { expect, test, type Page } from '@playwright/test'
import type { Engine, SaveResult } from '@elovox/engine'
import type { Living } from '../src/livingScript.ts'

type W = Window & { __elovox?: { engine: Engine; living: Living | null; ready: boolean; save(slot: string): Promise<SaveResult> } }
test.skip(process.env.BENCH_SAVE !== '1', 'set BENCH_SAVE=1 (quiet machine only)')
const ready = (page: Page) => page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 600_000 })
const p = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]! }

test('save and load costs', async ({ page }) => {
  test.setTimeout(1_800_000)
  const out: Record<string, unknown> = {}
  // Living: one first save, then 10 saves 10 s apart while the crews work (spec target: incremental stall ≤ 50 ms).
  await page.goto('/?scene=living'); await ready(page)
  await page.evaluate(() => (window as W).__elovox!.living!.startWork())
  const full = await page.evaluate(() => (window as W).__elovox!.save('bench-living'))
  const stalls: number[] = [], totals: number[] = [], regions: number[] = []
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(10_000)
    const r = await page.evaluate(() => (window as W).__elovox!.save('bench-living'))
    stalls.push(r.simStallMs); totals.push(r.totalMs); regions.push(r.regionsWritten)
  }
  out.living = { firstStallMs: full.simStallMs, firstBytes: full.bytes, stallP50: p(stalls, 0.5), stallP95: p(stalls, 0.95), totalP95: p(totals, 0.95), regions }
  // 1024²: the crowd scene's world; a full save (target ≤ 250 ms stall), then a load until ready against its generation.
  await page.goto('/?scene=crowd&units=0'); await ready(page)
  const genMs = await page.evaluate(() => (window as W).__elovox!.engine.terrain.initial.ms)
  const big = await page.evaluate(() => (window as W).__elovox!.save('bench-1024'))
  const t0 = Date.now()
  await page.goto('/?save=bench-1024'); await ready(page)
  const restoreMs = await page.evaluate(() => (window as W).__elovox!.engine.terrain.initial.ms)
  out.world1024 = { genMs, fullStallMs: big.simStallMs, bytes: big.bytes, totalMs: big.totalMs, simRestoreMs: restoreMs, pageToReadyMs: Date.now() - t0 }
  console.log(`SAVE BENCH ${JSON.stringify(out)}`)
  expect(out.living).toBeTruthy()
})
