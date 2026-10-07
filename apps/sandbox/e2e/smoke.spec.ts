import { expect, test, type Page } from '@playwright/test'
import type { Engine } from '@elovox/engine'
import type { TerrainEditor } from '@elovox/terrain-editor'
import type { Character } from '../src/character.ts'

type W = Window & { __elovox?: { engine: Engine; bean: Character; editor: TerrainEditor | null; ready: boolean } }

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

test('bean stands on the terrain, plays idle, and V switches to walk', async ({ page }) => {
  const errors = watchErrors(page)
  await boot(page, '/?size=128')
  const read = () => page.evaluate(() => {
    const { engine, bean } = (window as W).__elovox!
    const p = bean.root.position
    const below = engine.world.get(Math.floor(p.x), Math.round(p.y) - 1, Math.floor(p.z))
    const above = engine.world.get(Math.floor(p.x), Math.round(p.y), Math.floor(p.z))
    return { clip: bean.clip, time: bean.mixer.time, inScene: bean.root.parent === engine.scene, onGround: below !== 0 && above === 0 }
  })
  const a = await read()
  expect(a).toMatchObject({ clip: 'idle', inScene: true, onGround: true })
  await page.waitForFunction((t) => (window as W).__elovox!.bean.mixer.time > t + 0.2, a.time)
  await page.keyboard.press('v')
  expect((await read()).clip).toBe('walk')
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

// `still` freezes physics and random ticks: the world must stay exactly as generated for the chunk-diff check.
test('terrain scene generates on workers and regenerates an area', async ({ page }) => {
  const errors = watchErrors(page)
  await boot(page, '/?scene=terrain&size=256&still')
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
  expect(r.chunks).toBe(0) // same document: nothing changed, so nothing is remeshed
  expect(r.rejected).toContain('invalid terrain document')
  expect(r.bad).toContain('rect must be integers')
  await page.locator('#terrain-regen').click()
  await expect(page.locator('#terrain-last')).toContainText('regen:', { timeout: 60_000 })
  const shot = await page.locator('canvas').screenshot()
  expect(shot.byteLength).toBeGreaterThan(10_000)
  expect(errors).toEqual([])
})

test('terrain editor adds an op, drags it live, and undoes back to the original world', async ({ page }) => {
  const errors = watchErrors(page)
  await boot(page, '/?scene=terrain&size=256&edit')
  await expect(page.locator('#editor-toolbar')).toBeVisible()
  const idle = () => page.evaluate(() => (window as W).__elovox!.editor!.preview.idle())
  /** Top solid y on a coarse grid: changes wherever the terrain changes. */
  const heights = () => page.evaluate(() => {
    const e = (window as W).__elovox!.engine
    const out: number[] = []
    for (let z = 4; z < 256; z += 8) for (let x = 4; x < 256; x += 8) {
      let y = 127
      while (y > 0 && e.world.get(x, y, z) === 0) y--
      out.push(y)
    }
    return out
  })
  const original = await heights()
  const opCount = await page.evaluate(() => (window as W).__elovox!.editor!.session.doc.ops.length)

  await page.selectOption('#editor-add', 'hills:circle')
  await page.waitForFunction(() => (window as W).__elovox!.editor!.session.selected === 'hills-1')
  await idle()
  const added = await heights()
  expect(added).not.toEqual(original)

  // Regeneration raises the camera's terrain-following target. Let its damping finish before computing a screen pick.
  await page.waitForFunction(() => {
    const { current, goal } = (window as W).__elovox!.engine.controls
    return current.target.every((v, i) => Math.abs(v - goal.target[i]!) < 0.01)
  })
  const c = await page.evaluate(() => (window as W).__elovox!.editor!.handleScreen('center'))
  expect(c).not.toBeNull()
  const centreBefore = await page.evaluate(() => (window as W).__elovox!.editor!.session.doc.ops.at(-1)!.shape)
  await page.mouse.move(c!.x, c!.y)
  await page.mouse.down()
  for (let i = 1; i <= 6; i++) await page.mouse.move(c!.x + i * 12, c!.y)
  await page.mouse.up()
  await idle()
  const centreAfter = await page.evaluate(() => (window as W).__elovox!.editor!.session.doc.ops.at(-1)!.shape)
  expect(centreAfter).not.toEqual(centreBefore)
  expect(await heights()).not.toEqual(added)

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Control+z') // the drag
  await page.keyboard.press('Control+z') // the add
  expect(await page.evaluate(() => (window as W).__elovox!.editor!.session.doc.ops.length)).toBe(opCount)
  await idle()
  expect(await heights()).toEqual(original)
  await expect(page.locator('#editor-status')).not.toContainText('error')
  expect(errors).toEqual([])
})

test('terrain editor brushes paint height and biome live, and undo back to the original world', async ({ page }) => {
  test.setTimeout(300_000) // software GL: each live regen waits on slow frames
  const errors = watchErrors(page)
  await boot(page, '/?scene=terrain&size=256&edit')
  const idle = () => page.evaluate(() => (window as W).__elovox!.editor!.preview.idle())
  /** Top solid y on a coarse grid: changes wherever the terrain changes. */
  const heights = () => page.evaluate(() => {
    const e = (window as W).__elovox!.engine
    const out: number[] = []
    for (let z = 4; z < 256; z += 8) for (let x = 4; x < 256; x += 8) {
      let y = 127
      while (y > 0 && e.world.get(x, y, z) === 0) y--
      out.push(y)
    }
    return out
  })
  const original = await heights()
  /** The top solid block of a column: its height and block id. */
  const top = (x: number, z: number) => page.evaluate(([cx, cz]) => {
    const e = (window as W).__elovox!.engine
    let y = 127
    while (y > 0 && e.world.get(cx!, y, cz!) === 0) y--
    return { y, id: e.world.get(cx!, y, cz!) }
  }, [x, z] as const)

  await page.locator('#editor-mode-height').click()
  await expect(page.locator('#editor-brush')).toBeVisible()
  // A real pointer stroke across the middle of the canvas.
  const box = (await page.locator('canvas').boundingBox())!
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  await page.mouse.move(cx - 60, cy)
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) await page.mouse.move(cx - 60 + i * 10, cy)
  await page.mouse.up()
  await page.waitForFunction(() => (window as W).__elovox!.editor!.session.canUndo)
  await idle()

  // A strong stroke through the API, back and forth along z = 128.
  const columnBefore = await top(128, 128)
  await page.evaluate(() => {
    const b = (window as W).__elovox!.editor!.brushes
    b.setTool('raise')
    b.setSettings({ radius: 16, strength: 1, falloff: 0 })
    const pts: { x: number; y: number; z: number }[] = []
    for (let pass = 0; pass < 4; pass++) for (let x = 100; x <= 156; x += 4) pts.push({ x: pass % 2 ? 256 - x : x, y: 0, z: 128 })
    b.strokeThrough(pts)
  })
  await idle()
  expect(await heights()).not.toEqual(original)
  expect((await top(128, 128)).y).toBeGreaterThan(columnBefore.y) // the column under the stroke rose

  await page.locator('#editor-mode-biome').click()
  const paintedBefore = await top(75, 60)
  await page.evaluate(() => {
    const b = (window as W).__elovox!.editor!.brushes
    b.setBiome(2)
    b.setSettings({ radius: 12 })
    b.strokeThrough([{ x: 60, y: 0, z: 60 }, { x: 90, y: 0, z: 60 }])
  })
  await idle()
  expect(await page.evaluate(() => (window as W).__elovox!.editor!.session.doc.layers.biome !== undefined)).toBe(true)
  expect((await top(75, 60)).id).not.toBe(paintedBefore.id) // a column inside the painted cells got the other biome's surface

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z') // biome, API stroke, pointer stroke
  await idle()
  expect(await page.evaluate(() => (window as W).__elovox!.editor!.session.doc.layers)).toEqual({})
  expect(await heights()).toEqual(original)
  await expect(page.locator('#editor-status')).not.toContainText('error')
  expect(errors).toEqual([])
})
