import { expect, test, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import type { Engine } from '@elovox/engine'

type W = Window & { __elovox?: { engine: Engine; ready: boolean } }
/** The 1024² showcase, frozen. */
const SCENE = '/?scene=terrain&size=1024&still'
const GROUND = { t: [120, 120], d: 8, pitch: 0.15, yaw: -3 * Math.PI / 4 }
const ORBIT_LOW = { t: [512, 512], d: 400, pitch: 0.3, yaw: 0.7 }

async function boot(page: Page, url: string, errors: string[]): Promise<void> {
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(url)
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 240_000 })
  await page.waitForFunction(() => { const s = (window as W).__elovox!.engine.stats(); return s.meshQueue + s.meshInFlight === 0 }, null, { timeout: 240_000 })
}
async function pose(page: Page, p: { t: number[]; d: number; pitch: number; yaw: number }): Promise<void> {
  await page.evaluate(p => {
    const e = (window as W).__elovox!.engine
    for (const s of [e.controls.goal, e.controls.current]) { s.target[0] = p.t[0]!; s.target[2] = p.t[1]!; s.distance = p.d; s.pitch = p.pitch; s.yaw = p.yaw }
  }, p)
  await page.waitForTimeout(1500)
}
/** Sets the view distance; a negative value stands for Infinity (JSON cannot carry it). */
async function view(page: Page, r: number): Promise<void> {
  await page.evaluate(r => { (window as W).__elovox!.engine.quality = { viewDistance: r < 0 ? Infinity : r } }, r)
  await page.waitForTimeout(500)
}
const drawn = (page: Page) => page.evaluate(() => (window as W).__elovox!.engine.stats().chunksDrawn)

test('a finite view distance draws less, hides batches beyond it, ties camera.far, and Infinity restores everything', async ({ page }) => {
  test.setTimeout(400_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  const errors: string[] = []
  await boot(page, SCENE, errors)
  await pose(page, GROUND)
  const all = await drawn(page)
  await view(page, 256)
  const near = await drawn(page)
  const state = await page.evaluate(() => {
    const e = (window as W).__elovox!.engine, p = e.camera.position
    let beyond = 0
    e.scene.traverse(o => {
      if (!(o as { isBatchedMesh?: boolean }).isBatchedMesh || !o.visible) return
      const b = (o as unknown as { boundingBox: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } }).boundingBox
      const dx = Math.max(b.min.x - p.x, 0, p.x - b.max.x), dy = Math.max(b.min.y - p.y, 0, p.y - b.max.y), dz = Math.max(b.min.z - p.z, 0, p.z - b.max.z)
      if (Math.hypot(dx, dy, dz) > 256) beyond++
    })
    return { beyond, far: e.camera.far }
  })
  expect(near).toBeGreaterThan(0)
  expect(near).toBeLessThan(all)
  expect(state.beyond).toBe(0)
  expect(state.far).toBe(320)
  await view(page, -1)
  expect(await drawn(page)).toBe(all)
  expect(await page.evaluate(() => (window as W).__elovox!.engine.camera.far)).toBe(3000)
  expect(errors).toEqual([])
})

test('?nobatch also draws less at a finite view distance', async ({ page }) => {
  test.setTimeout(400_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  const errors: string[] = []
  await boot(page, SCENE + '&nobatch&view=256', errors)
  await pose(page, GROUND)
  const near = await drawn(page)
  await view(page, -1)
  expect(near).toBeGreaterThan(0)
  expect(near).toBeLessThan(await drawn(page))
  expect(errors).toEqual([])
})

test('every drawn material takes the scene fog (units and their models included), and fog off keeps an edge node', async ({ page }) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  await boot(page, '/?scene=workers&view=256', errors)
  await page.waitForTimeout(3000) // units spawn and load their models
  const bad = await page.evaluate(() => {
    const e = (window as W).__elovox!.engine, out: string[] = []
    let materials = 0
    e.scene.traverse(o => {
      const m = (o as { material?: unknown }).material
      if (!m) return
      for (const mat of ([] as { fog?: boolean; type?: string }[]).concat(m as never)) { materials++; if (mat.fog === false) out.push(`${o.name}:${mat.type}`) }
    })
    return { out, materials, fogNode: e.scene.fogNode !== null }
  })
  expect(bad.materials).toBeGreaterThan(10)
  expect(bad.out).toEqual([])
  expect(bad.fogNode).toBe(true)
  await page.evaluate(() => { (window as W).__elovox!.engine.effects = { fog: false } })
  await page.waitForTimeout(300)
  expect(await page.evaluate(() => (window as W).__elovox!.engine.scene.fogNode !== null)).toBe(true) // the edge-only node
  await view(page, -1)
  expect(await page.evaluate(() => (window as W).__elovox!.engine.scene.fogNode)).toBeNull() // as before 4b
  expect(errors).toEqual([])
})

test('checkpoint screenshots: R = Infinity, 384 and 256 at the ground and low-orbit poses, three presets', async ({ page }, info) => {
  test.skip(!process.env.VIEW_SHOTS, 'set VIEW_SHOTS=1 for the checkpoint screenshots')
  test.setTimeout(600_000)
  await page.setViewportSize({ width: 1920, height: 889 })
  const errors: string[] = []
  await boot(page, SCENE, errors)
  for (const [name, p] of [['ground', GROUND], ['orbit-low', ORBIT_LOW]] as const) {
    await pose(page, p)
    for (const preset of ['open', 'sunset', 'diorama']) {
      await page.evaluate(n => (window as W).__elovox!.engine.atmosphere.set(n), preset)
      for (const r of [-1, 384, 256]) {
        await view(page, r)
        await page.waitForTimeout(500)
        writeFileSync(info.outputPath(`${name}-${preset}-${r < 0 ? 'inf' : r}.png`), await page.locator('#view').screenshot())
      }
    }
  }
  expect(errors).toEqual([])
})
