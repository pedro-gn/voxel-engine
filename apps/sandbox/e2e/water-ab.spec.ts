import { test, type Browser } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Engine } from '@elovox/engine'
import type { Living } from '../src/livingScript.ts'

// 4a-r2 #2 attribution: the water host in-thread (A, ?nowaterworker) against in its worker (B), alternating ABBA then BABA in
// one browser session. Per window: frame cost, main-thread apply, host cost, the added lag, the queue and the mesh backlog.
// BENCH_WATER_AB=1 WATER_AB_OUT=… E2E_PREVIEW=1 E2E_PORT=5184 E2E_CHANNEL=msedge npx playwright test e2e/water-ab.spec.ts --headed --workers=1
type W = Window & { __elovox?: { engine: Engine; living: Living | null; ready: boolean } }
type Event = 'startWork' | 'breach' | 'collapse'
test.skip(!process.env.BENCH_WATER_AB, 'set BENCH_WATER_AB=1 for the water worker A/B')

/** ABBA then BABA; WATER_AB_ORDER overrides it (e.g. 'AB' for a smoke check of the spec itself). */
const ORDER = process.env.WATER_AB_ORDER ?? 'ABBABABA'
const WINDOWS: [string, 'far' | 'dam' | 'tower', Event, number][] = [
  ['work-far', 'far', 'startWork', 15_000], ['dam', 'dam', 'breach', 20_000], ['collapse', 'tower', 'collapse', 15_000],
]

async function runPage(browser: Browser, build: string, video: boolean) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 889 }, ...(video && { recordVideo: { dir: 'test-results/water-ab-video', size: { width: 960, height: 444 } } }) })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(`/?scene=living&gpu${build === 'A' ? '&nowaterworker' : ''}`)
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 300_000 })
  await page.waitForTimeout(10_000)
  await page.waitForFunction(() => { const s = (window as W).__elovox!.engine.stats(); return s.meshQueue === 0 && s.meshInFlight === 0 }, null, { timeout: 120_000 }).catch(() => {})
  const windows: Record<string, unknown> = {}
  for (const [name, camera, event, ms] of WINDOWS) {
    await page.bringToFront()
    await page.evaluate(c => (window as W).__elovox!.living!.camera(c), camera)
    await page.waitForTimeout(2000)
    windows[name] = await page.evaluate(async ({ ms, event }) => {
      const e = (window as W).__elovox!.engine
      const frames: number[] = [], cpu: number[] = [], backlog: number[] = [], apply: number[] = [], host: number[] = [], lag: number[] = []
      const offTick = e.on('tick', () => { const s = e.stats(); apply.push(s.waterApplyMs); host.push(s.waterHostMs); lag.push(s.waterLagMs) })
      let last = performance.now(), done = false
      const loop = (now: number) => {
        if (done) return
        frames.push(now - last); last = now
        const s = e.stats()
        cpu.push(s.frameMs); backlog.push(s.meshQueue + s.meshInFlight)
        requestAnimationFrame(loop)
      }
      requestAnimationFrame(loop)
      await new Promise(r => setTimeout(r, 1000))
      await (window as W).__elovox!.living![event]()
      await new Promise(r => setTimeout(r, ms - 1000))
      done = true; offTick()
      frames.shift()
      const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))]! : 0 }
      const r = (v: number) => Math.round(v * 100) / 100
      const s = e.stats()
      return {
        frames: frames.length, fpsP5: r(1000 / q(frames, .95)), cpuMedian: r(q(cpu, .5)), applyP95: r(q(apply, .95)), hostP95: r(q(host, .95)),
        lagP50: r(q(lag, .5)), lagP95: r(q(lag, .95)), lagP50Frames180: r(q(lag, .5) / (1000 / 180)), lagP95Frames180: r(q(lag, .95) / (1000 / 180)),
        lagP50Frames60: r(q(lag, .5) / (1000 / 60)), lagP95Frames60: r(q(lag, .95) / (1000 / 60)), queueMax: s.waterQueueMax,
        backlogMean: r(backlog.reduce((a, b) => a + b, 0) / Math.max(1, backlog.length)), backlogP95: q(backlog, .95), inWorker: s.waterInWorker,
      }
    }, { ms, event })
  }
  await context.close()
  return { windows, errors }
}

test('water host in-thread (A) against in its worker (B), alternating', async ({ browser }) => {
  test.setTimeout(1_800_000)
  const runs = []
  for (let i = 0; i < ORDER.length; i++) {
    const build = ORDER[i]!
    const { windows, errors } = await runPage(browser, build, i < 2)
    runs.push({ run: i + 1, build, windows, errors })
    console.log(`run ${i + 1} ${build}`, JSON.stringify(windows))
  }
  const path = process.env.WATER_AB_OUT ?? 'test-results/water-ab.json'
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ date: new Date().toISOString(), order: ORDER, runs }, null, 2))
})
