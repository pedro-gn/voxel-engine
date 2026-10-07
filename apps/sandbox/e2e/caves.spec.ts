import { expect, test, type Page, type TestInfo } from '@playwright/test'
import type { Engine } from '@elovox/engine'

type Caves = { digTunnel(): void; pierceRoof(): void; openDam(): void; openCanal(): void }
type W = Window & { __elovox?: { engine: Engine; caves: Caves | null; ready: boolean } }

async function open(page: Page): Promise<string[]> {
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/?scene=caves')
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 120_000 })
  return errors
}

/** Whether voxel (x, y, z) holds water. */
function wet(page: Page, x: number, y: number, z: number): Promise<boolean> {
  return page.evaluate(([x, y, z]) => {
    const e = (window as W).__elovox!.engine
    return (e.world.get(x!, y!, z!) & 0xfff) === e.blocks.id('water')
  }, [x, y, z])
}

async function capture(page: Page, testInfo: TestInfo, name: string, target: [number, number, number], distance: number): Promise<void> {
  await page.evaluate(({ target, distance }) => {
    const e = (window as W).__elovox!.engine
    for (const state of [e.controls.current, e.controls.goal]) {
      state.target = [...target]; state.distance = distance; state.pitch = 0.8; state.yaw = 0.7
    }
    e.controls.apply(e.camera)
  }, { target, distance })
  // Render the camera change before taking the canvas: frames can be slow on a software GPU.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const path = testInfo.outputPath(`${name}.png`)
  await page.locator('canvas').screenshot({ path })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

test('the pierced roof pours the pond into the cave; the dam hole drains into the valley; the tunnel lifts the shaft', async ({ page }, testInfo) => {
  test.setTimeout(300_000)
  const errors = await open(page)
  expect(await wet(page, 80, 18, 15)).toBe(false)
  await page.evaluate(() => { const c = (window as W).__elovox!.caves!; c.pierceRoof(); c.openDam(); c.digTunnel() })
  await page.waitForFunction(() => {
    const e = (window as W).__elovox!.engine, water = e.blocks.id('water')
    return (e.world.get(80, 18, 15) & 0xfff) === water
  }, null, { timeout: 180_000, polling: 1000 })
  await page.waitForFunction(() => {
    const e = (window as W).__elovox!.engine, water = e.blocks.id('water')
    for (let x = 20; x <= 40; x++) if ((e.world.get(x, 10, 50) & 0xfff) === water) return true
    return false
  }, null, { timeout: 180_000, polling: 1000 })
  await page.waitForFunction(() => {
    const e = (window as W).__elovox!.engine
    return (e.world.get(80, 25, 27) & 0xfff) === e.blocks.id('water') // above the tunnel's roof: pressure lifted it
  }, null, { timeout: 180_000, polling: 1000 })
  await capture(page, testInfo, 'dam-hole', [28, 20, 49], 65)
  await capture(page, testInfo, 'pierced-roof', [80, 24, 15], 45)
  await capture(page, testInfo, 'u-tunnel-shaft', [65, 26, 27], 90)
  expect(errors).toEqual([])
})

test('the canal flows under both bridges, with matching surface corners across layers and dry decks', async ({ page }, testInfo) => {
  test.setTimeout(240_000)
  const errors = await open(page)
  await page.evaluate(() => (window as W).__elovox!.caves!.openCanal())
  // The low bridge starts full. Wait until the neighbouring free surfaces are below its deck too: above it, the deck
  // separates those surfaces from the slot under it, so their corners intentionally do not join.
  await page.waitForFunction(() => {
    const e = (window as W).__elovox!.engine
    const mesh = e.scene.getObjectByName('water-1-7') as unknown as { geometry: { getAttribute(name: string): { array: Float32Array } } } | undefined
    if (!mesh || mesh.geometry.getAttribute('info').array[(5 + 28 * 32) * 4 + 3]! < 0) return false
    const top = e.scene.getObjectByName('water-0-7') as unknown as { geometry: { getAttribute(name: string): { array: Float32Array } } } | undefined
    if (!top) return false
    const heights = top.geometry.getAttribute('hCur').array
    for (const z of [59, 61]) for (let k = 0; k < 4; k++) if (heights[(5 + (z & 31) * 32) * 4 + k]! >= 29) return false
    return true
  }, null, { timeout: 180_000, polling: 1000 })
  await page.waitForFunction(() => {
    const e = (window as W).__elovox!.engine
    return (e.world.get(90, 10, 101) & 0xfff) === e.blocks.id('water')
  }, null, { timeout: 60_000, polling: 1000 })
  // Hold the simulation at one accepted tick while checking corners from the worker-to-renderer path.
  await page.evaluate(() => (window as W).__elovox!.engine.physics.setPaused(true))
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const bridges = await page.evaluate(() => {
    const e = (window as W).__elovox!.engine
    const slot = (x: number, z: number, rank: number) => {
      const cc = (x >> 5) + (z >> 5) * 4, o = ((x & 31) + (z & 31) * 32) * 4
      const mesh = e.scene.getObjectByName(`water-${rank}-${cc}`) as unknown as { geometry: { getAttribute(name: string): { array: Float32Array } } }
      return { h: [...mesh.geometry.getAttribute('hCur').array.subarray(o, o + 4)], packed: mesh.geometry.getAttribute('info').array[o + 3]! }
    }
    return [{ z: 40, deck: 31 }, { z: 60, deck: 29 }].map(({ z, deck }) => ({
      under: slot(101, z, 1), before: slot(101, z - 1, 0), after: slot(101, z + 1, 0), top: slot(101, z, 0),
      deckSolid: e.world.get(101, deck, z) === e.blocks.id('stone'), aboveDry: e.world.get(101, deck + 1, z) === 0,
    }))
  })
  for (const b of bridges) {
    expect(b.under.packed).toBeGreaterThanOrEqual(0)
    expect(b.top.packed).toBeLessThan(0)
    expect(b.deckSolid).toBe(true)
    expect(b.aboveDry).toBe(true)
    expect(b.under.h[0]).toBeCloseTo(b.before.h[3]!, 5)
    expect(b.under.h[1]).toBeCloseTo(b.before.h[2]!, 5)
    expect(b.under.h[2]).toBeCloseTo(b.after.h[1]!, 5)
    expect(b.under.h[3]).toBeCloseTo(b.after.h[0]!, 5)
  }
  await capture(page, testInfo, 'bridged-canal', [102, 28, 50], 65)
  expect(errors).toEqual([])
})
