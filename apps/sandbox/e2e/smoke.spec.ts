import { expect, test, type Page } from '@playwright/test'
import type { Engine } from '@elovox/engine'

type W = Window & { __elovox?: { engine: Engine; ready: boolean } }

function watchErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(e.message))
  return errors
}
async function boot(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 90_000 })
}

test('sandbox boots isolated, renders, and round-trips an edit', async ({ page }) => {
  const errors = watchErrors(page)
  await boot(page, '/?size=128')
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)
  const r = await page.evaluate(async () => {
    type A = { seq: number; ok: boolean }
    const e = (window as W).__elovox!.engine
    const ack = (seq: number) => new Promise<A>((res) => { const off = e.on('ack', (a) => { if (a.seq === seq) { off(); res(a) } }) })
    const stone = e.blocks.id('stone')
    const s1 = e.submit({ type: 'setBlock', pos: [10, 120, 10], voxel: stone })
    const ghost = e.world.get(10, 120, 10)
    const a1 = await ack(s1)
    const placed = e.world.get(10, 120, 10)
    const a2 = await ack(e.submit({ type: 'setBlock', pos: [10, 120, 10], voxel: 0 }))
    const bad = await ack(e.submit({ type: 'setBlock', pos: [10, 128, 10], voxel: stone }))
    return { stone, ghost, a1: a1.ok, placed, a2: a2.ok, removed: e.world.get(10, 120, 10), bad: bad.ok }
  })
  expect(r).toEqual({ stone: r.stone, ghost: r.stone, a1: true, placed: r.stone, a2: true, removed: 0, bad: false })
  await expect(page.locator('#hud')).toContainText('fps')
  const shot = await page.locator('canvas').screenshot()
  expect(shot.byteLength).toBeGreaterThan(10_000) // a blank canvas compresses to far less
  expect(errors).toEqual([])
})

for (const scene of ['world', 'diorama'] as const) {
  test(`${scene} scene renders on WebGL2 and switches presets and effects from the HUD`, async ({ page }) => {
    const errors = watchErrors(page)
    await boot(page, scene === 'world' ? '/?size=128&webgl' : '/?scene=diorama&webgl')
    expect(await page.evaluate(() => (window as W).__elovox!.engine.stats().backend)).toBe('webgl')
    await page.locator('#preset-sunset').click()
    await page.waitForFunction(() => (window as W).__elovox!.engine.atmosphere.current.sun.elevation < 15, null, { timeout: 60_000 })
    await page.locator('#fx-shadows').uncheck()
    expect(await page.evaluate(() => (window as W).__elovox!.engine.effects.shadows)).toBe(false)
    await page.locator('#fx-shadows').check()
    const shot = await page.locator('canvas').screenshot()
    expect(shot.byteLength).toBeGreaterThan(10_000)
    expect(errors).toEqual([])
  })
}

test('terrain scene generates on workers and regenerates an area', async ({ page }) => {
  const errors = watchErrors(page)
  await boot(page, '/?scene=terrain&size=256')
  const r = await page.evaluate(async () => {
    const e = (window as W).__elovox!.engine
    const initial = e.terrain.initial
    const regen = await e.terrain.regenerate({ x0: 64, z0: 64, x1: 192, z1: 192 })
    let rejected = ''
    try { await e.terrain.setDocument({ format: 'elovox-terrain' }) } catch (err) { rejected = (err as Error).message }
    let bad = ''
    try { await e.terrain.regenerate({ x0: 0, z0: 0, x1: 999, z1: 10 }) } catch (err) { bad = (err as Error).message }
    return { columns: initial.columns, ms: initial.ms, chunks: regen.chunks, rejected, bad }
  })
  expect(r.columns).toBe(64)
  expect(r.ms).toBeGreaterThan(0)
  expect(r.chunks).toBeGreaterThan(0)
  expect(r.rejected).toContain('invalid terrain document')
  expect(r.bad).toContain('rect must be integers')
  await page.locator('#terrain-regen').click()
  await expect(page.locator('#terrain-last')).toContainText('regen:', { timeout: 60_000 })
  const shot = await page.locator('canvas').screenshot()
  expect(shot.byteLength).toBeGreaterThan(10_000)
  expect(errors).toEqual([])
})
