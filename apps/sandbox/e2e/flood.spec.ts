import { expect, test, type Page } from '@playwright/test'
import type { Engine } from '@elovox/engine'

type Flood = { breach(): void; drop(): void; stopSpring(): void; dig(): void }
type W = Window & { __elovox?: { engine: Engine; flood: Flood | null; ready: boolean }; __flat?: number }

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}

async function open(page: Page): Promise<void> {
  await page.goto('/?scene=flood')
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 120_000 })
}

/** Lowest and highest mirrored water top (y × 8 + level) over the lake's interior, every 3rd column; null when there is none. */
async function lakeRange(page: Page): Promise<[number, number] | null> {
  return page.evaluate(() => {
    const e = (window as W).__elovox!.engine
    const water = e.blocks.id('water')
    let lo = Infinity, hi = -Infinity
    for (let x = 25; x <= 124; x += 3) for (let z = 25; z <= 124; z += 3) {
      for (let y = 30; y >= 20; y--) {
        const v = e.world.get(x, y, z)
        if ((v & 0xfff) === water) {
          const h = y * 8 + ((v >>> 12) & 7)
          lo = Math.min(lo, h)
          hi = Math.max(hi, h)
          break
        }
      }
    }
    return lo === Infinity ? null : [lo, hi] as [number, number]
  })
}

// Timings measured in headless Chromium (SwiftShader, ~0.5 fps; the sim runs in its worker regardless, at ~20 Hz):
// after the breach the lake top drops and the valley is wet within ~10 s. Among the wet columns the lake surface is flat
// to one mirror level only at ~1260 s (21 min), so that part is gated behind E2E_SLOW=1. Every tile sleeping takes
// ~151 000 ticks (~2 h), measured by `npm run bench:dam settle` instead.
async function breach(page: Page): Promise<void> {
  await page.evaluate(() => { const f = (window as W).__elovox!.flood!; f.stopSpring(); f.breach() })
  // the lake goes down: its top cell at (60, 24, 60) is no longer full
  await page.waitForFunction(() => {
    const e = (window as W).__elovox!.engine
    const v = e.world.get(60, 24, 60)
    return (v & 0xfff) !== e.blocks.id('water') || ((v >>> 12) & 7) < 7
  }, null, { timeout: 120_000, polling: 1000 })
}

async function valleyWater(page: Page): Promise<number> {
  return page.evaluate(() => {
    const e = (window as W).__elovox!.engine
    const water = e.blocks.id('water')
    let n = 0
    for (let x = 126; x < 160; x++) for (let z = 50; z < 100; z++) for (let y = 9; y < 14; y++) if ((e.world.get(x, y, z) & 0xfff) === water) n++
    return n
  })
}

test('a breached lake drains: the lake goes down and the valley gets water', async ({ page }) => {
  test.setTimeout(240_000)
  const errors = watchErrors(page)
  await open(page)
  expect(await lakeRange(page)).toEqual([24 * 8 + 7, 24 * 8 + 7])
  await breach(page)
  expect(await valleyWater(page)).toBeGreaterThan(0)
  expect(errors).toEqual([])
})

test('a breached lake ends flat among its wet columns', async ({ page }) => {
  test.skip(!process.env.E2E_SLOW, 'set E2E_SLOW=1: waits ~21 min for the lake to flatten')
  test.setTimeout(2_400_000)
  const errors = watchErrors(page)
  await open(page)
  await breach(page)
  // flat among the wet columns: the lake's interior varies by at most one mirror level for 3 samples in a row. It still
  // creeps down as it films out, so this is not a sleeping scene and does not wait for physicsBusy to clear.
  await page.evaluate(() => { (window as W).__flat = 0 })
  await page.waitForFunction(() => {
    const w = window as W
    const e = w.__elovox!.engine
    const water = e.blocks.id('water')
    let lo = Infinity, hi = -Infinity
    for (let x = 25; x <= 124; x += 3) for (let z = 25; z <= 124; z += 3) {
      for (let y = 30; y >= 20; y--) {
        const v = e.world.get(x, y, z)
        if ((v & 0xfff) === water) { const h = y * 8 + ((v >>> 12) & 7); lo = Math.min(lo, h); hi = Math.max(hi, h); break }
      }
    }
    w.__flat = hi - lo <= 1 ? (w.__flat ?? 0) + 1 : 0
    return w.__flat >= 3
  }, null, { timeout: 1_800_000, polling: 10_000 })
  const range = await lakeRange(page)
  expect(range).not.toBeNull()
  expect(range![1] - range![0]).toBeLessThanOrEqual(1) // what is left on the lake bed lies flat
  expect(errors).toEqual([])
})

test('a channel dug beside the lake fills', async ({ page }) => {
  test.setTimeout(240_000)
  const errors = watchErrors(page)
  await open(page)
  await page.evaluate(() => (window as W).__elovox!.flood!.dig())
  await page.waitForFunction(() => {
    const e = (window as W).__elovox!.engine
    const water = e.blocks.id('water')
    return (e.world.get(6, 22, 41) & 0xfff) === water && (e.world.get(4, 22, 41) & 0xfff) === water // the far end too
  }, null, { timeout: 120_000, polling: 500 })
  expect(errors).toEqual([])
})

test('sand pillars fall, one into the lake', async ({ page }) => {
  test.setTimeout(240_000)
  const errors = watchErrors(page)
  await open(page)
  await page.evaluate(() => (window as W).__elovox!.flood!.drop())
  await page.waitForFunction(() => {
    const e = (window as W).__elovox!.engine
    return e.world.get(60, 25, 160) === e.blocks.id('sand') && e.world.get(60, 40, 160) === 0
  }, null, { timeout: 60_000, polling: 250 })
  expect(errors).toEqual([])
})
