import { expect, test, type Page } from '@playwright/test'
import type { Engine } from '@elovox/engine'

type W = Window & { __elovox?: { engine: Engine; ready: boolean } }
test.skip(process.env.BENCH_CUT !== '1', 'set BENCH_CUT=1 (quiet machine only)')
const p = (xs: number[], q: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]! }
/** The sky island's highest layer: the first cut step starts there. */
const ISLAND_TOP = 60
const STEPS = 12

/** Moves the cut and measures, in the page, until every chunk is meshed and uploaded and one more frame was rendered. */
const step = (page: Page, y: number) => page.evaluate((y) => new Promise<number>((resolve) => {
  const e = (window as W).__elovox!.engine
  const t0 = performance.now()
  e.view.cut(y)
  const off = e.on('frame', () => {
    const s = e.stats()
    if (s.meshQueue !== 0 || s.meshInFlight !== 0) return
    off()
    // One more frame: the meshes uploaded by the last upload are drawn by it.
    const after = e.on('frame', () => { after(); resolve(performance.now() - t0) })
  })
}), y)

test('one layer-cut step on the 256² sky island is drawn within 150 ms (spec §4)', async ({ page }) => {
  test.setTimeout(300_000)
  await page.goto('/?scene=sky')
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 120_000 })
  await page.waitForFunction(() => { const s = (window as W).__elovox!.engine.stats(); return s.meshQueue === 0 && s.meshInFlight === 0 }, null, { timeout: 120_000 })
  // The scene's first seconds hold one-off stalls of up to ~2.5 s with no cut at all (first appearances: the waterfall,
  // the units). Measure only after 5 s of frames with no gap over 150 ms, so the steps time the cut alone.
  await page.evaluate(() => new Promise<void>((resolve) => {
    const e = (window as W).__elovox!.engine
    let last = performance.now(), calm = last
    const off = e.on('frame', () => { const n = performance.now(); if (n - last > 150) calm = n; last = n; if (n - calm > 5000) { off(); resolve() } })
  }))
  const ms: number[] = []
  for (let i = 0; i < STEPS; i++) ms.push(await step(page, ISLAND_TOP - i))
  const out = { cutStepMs: { p50: p(ms, 0.5), p95: p(ms, 0.95), max: Math.max(...ms) }, steps: ms.map(v => Math.round(v)) }
  console.log(`CUT BENCH ${JSON.stringify(out)}`)
  if (process.env.BENCH_ASSERT === '1') expect(out.cutStepMs.p95).toBeLessThanOrEqual(150)
})
