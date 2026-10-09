// Per-frame anatomy of the living scene (4a-r2): which frames are long and what the main thread did in them. ANATOMY=1;
// ANATOMY_QUERY appends to the URL; ANATOMY_OUT sets the file. Summarize with `node bench/anatomy.node.mjs <file>`.
// ANATOMY=1 E2E_PREVIEW=1 E2E_PORT=5184 E2E_CHANNEL=msedge npx playwright test e2e/living-anatomy.spec.ts --headed --workers=1
import { test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { Engine } from '@elovox/engine'
import type { Living } from '../src/livingScript.ts'

type W = Window & { __elovox?: { engine: Engine; living: Living | null; ready: boolean } }
test.skip(!process.env.ANATOMY, 'set ANATOMY=1')

const SCRIPT: [string, 'default' | 'far' | 'dam' | 'tower', 'startWork' | 'breach' | 'collapse' | null, number][] = [
  ['idle-default', 'default', null, 10_000], ['idle-far', 'far', null, 10_000],
  ['work-default', 'default', 'startWork', 15_000], ['dam', 'dam', 'breach', 20_000], ['collapse', 'tower', 'collapse', 15_000],
]

test('frame anatomy', async ({ page }) => {
  test.setTimeout(900_000)
  await page.setViewportSize({ width: 1920, height: 889 })
  const query = process.env.ANATOMY_QUERY ?? ''
  await page.goto(`/?scene=living&gpu${query}`)
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 300_000 })
  await page.waitForTimeout(10_000)
  const out: Record<string, unknown> = {}
  for (const [phase, camera, event, ms] of SCRIPT) {
    await page.bringToFront()
    await page.evaluate(c => (window as W).__elovox!.living!.camera(c), camera)
    await page.waitForTimeout(2000)
    out[phase] = await page.evaluate(async ({ ms, event }) => {
      const e = (window as W).__elovox!.engine
      const frames: number[][] = [], ticks: number[][] = [], gpu: number[] = []
      const offF = e.on('frame', ({ now }) => { const s = e.stats(); frames.push([now, s.frameMs]); if (s.gpuMs !== null) gpu.push(s.gpuMs) })
      const offT = e.on('tick', t => { ticks.push([performance.now(), e.stats().waterApplyMs, t.tickMs]) })
      await new Promise(r => setTimeout(r, 1000))
      if (event) await (window as W).__elovox!.living![event]()
      await new Promise(r => setTimeout(r, ms - 1000))
      offF(); offT()
      return { frames, ticks, gpu: [...new Set(gpu)] }
    }, { ms, event })
  }
  mkdirSync('test-results', { recursive: true })
  writeFileSync(process.env.ANATOMY_OUT ?? 'test-results/anatomy.json', JSON.stringify(out))
})
