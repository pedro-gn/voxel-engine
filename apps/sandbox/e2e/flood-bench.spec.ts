import { expect, test } from '@playwright/test'
import type { Engine } from '@elovox/engine'

type W = Window & { __elovox?: { engine: Engine; flood: { breach(): void; drop(): void } | null; ready: boolean } }

test.skip(!process.env.BENCH, 'set BENCH=1 to run the dam-break benchmark')

test('dam break: sim tick p95, fps, time to settle', async ({ page }) => {
  test.setTimeout(1_200_000)
  await page.goto('/?scene=flood')
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 180_000 })
  const r = await page.evaluate(async () => {
    const e = (window as W).__elovox!.engine
    const ticks: number[] = [], fps: number[] = []
    let peak = 0, quiet = 0
    const t0 = performance.now()
    e.on('tick', (t) => ticks.push(t.tickMs))
    ;(window as W).__elovox!.flood!.breach()
    while (performance.now() - t0 < 900_000) {
      await new Promise((res) => setTimeout(res, 500))
      const s = e.stats()
      fps.push(s.fps)
      peak = Math.max(peak, s.fluidActive)
      quiet = !s.physicsBusy && s.fallingBodies === 0 ? quiet + 1 : 0
      if (quiet >= 3) break
    }
    const sorted = [...ticks].sort((a, b) => a - b)
    const fs = [...fps].sort((a, b) => a - b)
    return {
      settled: quiet >= 3, settleS: (performance.now() - t0) / 1000, ticks: ticks.length,
      tickP95: sorted[Math.floor(sorted.length * 0.95)] ?? 0, tickMax: sorted[sorted.length - 1] ?? 0,
      fpsMin: fs[0] ?? 0, fpsMedian: fs[Math.floor(fs.length / 2)] ?? 0, peakActive: peak,
    }
  })
  console.log(`[flood-bench] ${JSON.stringify(r)}`)
  expect(r.settled).toBe(true)
})
