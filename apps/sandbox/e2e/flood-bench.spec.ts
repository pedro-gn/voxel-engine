import { expect, test, type Page } from '@playwright/test'
import type { Engine } from '@elovox/engine'

type Flood = { breach(): void; drop(): void; stopSpring(): void; stress(): void; dig(): void }
type W = Window & { __elovox?: { engine: Engine; flood: Flood | null; ready: boolean } }

test.skip(!process.env.BENCH, 'set BENCH=1 to run the dam-break benchmarks')

/**
 * Stops the river's spring (otherwise its river tiles never sleep), runs `start`, then samples
 * every 500 ms until settled: no physics work and no falling bodies for 3 samples in a row. Quiet samples
 * count only once the lake's surface (read at 60, 60) has dropped at least one level, so the time before the
 * breach takes effect is never mistaken for a settled scene.
 */
async function run(page: Page, start: 'breach' | 'stress', limitMs: number) {
  await page.goto('/?scene=flood')
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 180_000 })
  return page.evaluate(async ({ start, limitMs }) => {
    const e = (window as W).__elovox!.engine
    const flood = (window as W).__elovox!.flood!
    const water = e.blocks.id('water')
    const lakeHeight = () => {
      for (let y = 30; y >= 15; y--) {
        const v = e.world.get(60, y, 60)
        if ((v & 0xfff) === water) return y * 8 + ((v >>> 12) & 7)
      }
      return 0
    }
    const h0 = lakeHeight()
    const ticks: number[] = [], fps: number[] = []
    let peak = 0, quiet = 0, droppedS = -1
    e.on('tick', (t) => ticks.push(t.tickMs))
    flood.stopSpring()
    flood[start]()
    const t0 = performance.now()
    while (performance.now() - t0 < limitMs) {
      await new Promise((res) => setTimeout(res, 500))
      const s = e.stats()
      fps.push(s.fps)
      peak = Math.max(peak, s.waterColumns)
      if (droppedS < 0 && lakeHeight() < h0) droppedS = (performance.now() - t0) / 1000
      quiet = droppedS >= 0 && !s.physicsBusy && s.fallingBodies === 0 ? quiet + 1 : 0
      if (quiet >= 3) break
    }
    const sorted = [...ticks].sort((a, b) => a - b)
    const fs = [...fps].sort((a, b) => a - b)
    return {
      settled: quiet >= 3, settleS: (performance.now() - t0) / 1000, lakeDroppedS: droppedS, ticks: ticks.length,
      tickP95: sorted[Math.floor(sorted.length * 0.95)] ?? 0, tickMax: sorted[sorted.length - 1] ?? 0,
      fpsMin: fs[0] ?? 0, fpsMedian: fs[Math.floor(fs.length / 2)] ?? 0, peakColumns: peak,
    }
  }, { start, limitMs })
}

test('dam break: sim tick p95, fps, time to settle', async ({ page }) => {
  test.setTimeout(1_200_000)
  const r = await run(page, 'breach', 1_000_000)
  console.log(`[flood-bench] ${JSON.stringify(r)}`)
  expect(r.settled).toBe(true)
})

test('stress: whole dam open plus a 40 × 40 × 4 water dump into the valley', async ({ page }) => {
  test.setTimeout(1_200_000)
  const r = await run(page, 'stress', 1_000_000)
  console.log(`[flood-bench stress] ${JSON.stringify(r)}`)
  expect(r.settled).toBe(true)
})
