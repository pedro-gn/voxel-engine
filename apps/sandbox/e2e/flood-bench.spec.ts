import { test, type Page } from '@playwright/test'
import type { Engine } from '@elovox/engine'

type Flood = { breach(): void; drop(): void; stopSpring(): void; stress(): void; dig(): void }
type W = Window & { __elovox?: { engine: Engine; flood: Flood | null; ready: boolean } }

test.skip(!process.env.BENCH, 'set BENCH=1 to run the dam-break benchmarks')

/** The peak window measured after the breach (or the stress) starts: the water moves most in its first minute and a half. */
const WINDOW_MS = 90_000

/**
 * Stops the river's spring, runs `start`, then measures the peak window: every sim tick's time (ms), the fps every 500 ms,
 * and the main-thread water apply cost (engine stats: the largest single apply seen at a tick, and the largest running p95
 * over 200 applies seen every 500 ms). It also reports when the lake's surface at (60, 60) first dropped and when the valley
 * below the breach first got wet (s after the start; −1: not within the window). It does not wait for the scene to settle:
 * every tile sleeping takes ~2 h (`npm run bench:dam settle` measures that in Node).
 */
async function run(page: Page, start: 'breach' | 'stress') {
  await page.goto('/?scene=flood')
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 180_000 })
  return page.evaluate(async ({ start, windowMs }) => {
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
    // The valley floor (y 9) just below the breach (x 126..140, z 70..79).
    const valleyWet = () => {
      for (let x = 126; x <= 140; x++) for (let z = 70; z <= 79; z++) if ((e.world.get(x, 9, z) & 0xfff) === water) return true
      return false
    }
    const h0 = lakeHeight()
    const ticks: number[] = [], fps: number[] = []
    let peak = 0, droppedS = -1, wetS = -1, applyMax = 0, applyP95Max = 0
    const off = e.on('tick', (t) => {
      ticks.push(t.tickMs)
      applyMax = Math.max(applyMax, e.stats().waterApplyMs)
    })
    flood.stopSpring()
    flood[start]()
    const t0 = performance.now()
    while (performance.now() - t0 < windowMs) {
      await new Promise((res) => setTimeout(res, 500))
      const s = e.stats(), at = (performance.now() - t0) / 1000
      fps.push(s.fps)
      peak = Math.max(peak, s.waterColumns)
      applyP95Max = Math.max(applyP95Max, s.waterApplyP95)
      if (droppedS < 0 && lakeHeight() < h0) droppedS = at
      if (wetS < 0 && valleyWet()) wetS = at
    }
    off()
    const q = (a: number[], p: number) => {
      const s = [...a].sort((x, y) => x - y)
      return s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.floor(s.length * p))]!
    }
    return {
      windowS: windowMs / 1000, lakeDroppedS: droppedS, valleyWetS: wetS, ticks: ticks.length, peakColumns: peak,
      tickP50: q(ticks, 0.5), tickP95: q(ticks, 0.95), tickMax: q(ticks, 1),
      applyP95Max, applyMax,
      fpsMin: q(fps, 0), fpsP5: q(fps, 0.05), fpsMedian: q(fps, 0.5),
    }
  }, { start, windowMs: WINDOW_MS })
}

test('dam break: sim tick, water apply and fps over the peak window', async ({ page }) => {
  test.setTimeout(WINDOW_MS + 300_000)
  const r = await run(page, 'breach')
  console.log(`[flood-bench] ${JSON.stringify(r)}`)
})

test('stress: whole dam open plus a 40 × 40 × 4 water dump into the valley', async ({ page }) => {
  test.setTimeout(WINDOW_MS + 300_000)
  const r = await run(page, 'stress')
  console.log(`[flood-bench stress] ${JSON.stringify(r)}`)
})
