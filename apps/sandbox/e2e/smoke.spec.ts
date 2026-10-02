import { expect, test } from '@playwright/test'

test('sandbox boots isolated, renders, and round-trips an edit', async ({ page }) => {
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto('/?size=128')
  await page.waitForFunction(() => (window as unknown as { __elovox?: { ready: boolean } }).__elovox?.ready === true, null, { timeout: 90_000 })
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true)

  const r = await page.evaluate(async () => {
    type A = { seq: number; ok: boolean }
    const e = (window as unknown as { __elovox: { engine: {
      submit(c: unknown): number
      on(t: 'ack', fn: (a: A) => void): () => void
      world: { get(x: number, y: number, z: number): number }
      blocks: { id(n: string): number }
    } } }).__elovox.engine
    const ack = (seq: number) => new Promise<A>((res) => { const off = e.on('ack', (a) => { if (a.seq === seq) { off(); res(a) } }) })
    const stone = e.blocks.id('stone')
    const s1 = e.submit({ type: 'setBlock', pos: [10, 120, 10], voxel: stone })
    const ghost = e.world.get(10, 120, 10)
    const a1 = await ack(s1)
    const placed = e.world.get(10, 120, 10)
    const s2 = e.submit({ type: 'setBlock', pos: [10, 120, 10], voxel: 0 })
    const a2 = await ack(s2)
    const bad = await ack(e.submit({ type: 'setBlock', pos: [10, 128, 10], voxel: stone }))
    return { stone, ghost, a1: a1.ok, placed, a2: a2.ok, removed: e.world.get(10, 120, 10), bad: bad.ok }
  })
  expect(r).toEqual({ stone: r.stone, ghost: r.stone, a1: true, placed: r.stone, a2: true, removed: 0, bad: false })

  await expect(page.locator('#hud')).toContainText('fps')
  const shot = await page.locator('canvas').screenshot()
  expect(shot.byteLength).toBeGreaterThan(10_000) // a blank canvas compresses to far less
  expect(errors).toEqual([])
})
