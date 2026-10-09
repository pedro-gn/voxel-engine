import { expect, test, type Page } from '@playwright/test'
import type { Engine } from '@elovox/engine'
import type { FirstPersonUi } from '../src/firstPerson.ts'

type W = Window & { __elovox?: { engine: Engine; fp: FirstPersonUi | null; ready: boolean } }

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

test('first person: walk, jump, place refusal, place, dig, back to orbit', async ({ page }) => {
  const errors = watchErrors(page)
  await boot(page, '/?size=128&still')
  // A stone pad at y = 120 (top 121) above any terrain, with the orbit target at its centre.
  await page.evaluate(async () => {
    const e = (window as W).__elovox!.engine
    const seq = e.submit({ type: 'fillRegion', min: [8, 120, 8], max: [39, 120, 39], voxel: e.blocks.id('stone') })
    await new Promise<void>((res) => { const off = e.on('ack', (a) => { if (a.seq === seq) { off(); res() } }) })
    for (const s of [e.controls.goal, e.controls.current]) { s.target[0] = 24; s.target[2] = 24 }
  })
  await page.keyboard.press('c')
  const state = () => page.evaluate(() => {
    const { engine: e } = (window as W).__elovox!
    return { mode: e.cameraMode, fov: e.camera.fov, pos: [...e.firstPerson.position], grounded: e.firstPerson.grounded }
  })
  expect(await state()).toMatchObject({ mode: 'firstPerson', fov: 70 })
  await page.waitForFunction(() => { const f = (window as W).__elovox!.engine.firstPerson; return f.grounded && f.position[1] === 121 })

  // Walk toward −z for a second.
  await page.evaluate(() => { const f = (window as W).__elovox!.engine.firstPerson; f.yaw = 0; f.pitch = 0; f.input.forward = 1 })
  await page.waitForFunction(() => (window as W).__elovox!.engine.firstPerson.position[2] < 21, null, { timeout: 5_000 })
  await page.evaluate(() => { (window as W).__elovox!.engine.firstPerson.input.forward = 0 })
  const walked = await state()
  expect(walked.pos[1]).toBe(121)
  expect(walked.pos[0]).toBeCloseTo(24, 5)

  // Jump: rises above 122 and lands back on 121.
  const apex = await page.evaluate(() => new Promise<number>((res) => {
    const e = (window as W).__elovox!.engine, f = e.firstPerson
    let max = 0
    f.input.jump = true
    setTimeout(() => { f.input.jump = false }, 50)
    const off = e.on('frame', () => { max = Math.max(max, f.position[1]) })
    setTimeout(() => { off(); res(max) }, 1200)
  }))
  expect(apex).toBeGreaterThan(122)
  await page.waitForFunction(() => { const f = (window as W).__elovox!.engine.firstPerson; return f.grounded && f.position[1] === 121 })

  const r = await page.evaluate(async () => {
    const { engine: e, fp } = (window as W).__elovox!
    const f = e.firstPerson, stone = e.blocks.id('stone')
    const centre = () => e.raycast(f.eye(), f.forward(), 5)!
    f.pitch = -(Math.PI / 2 - 0.02)                    // straight down: the cell above the hit is the player's own
    const refused = fp!.place()
    f.pitch = -Math.atan2(1.62, 2.5)                    // the pad top 2.5 blocks ahead
    const a = centre().pos
    const placed = fp!.place()
    const ahead = e.world.get(a[0], a[1] + 1, a[2])   // a ghost edit reads back at once
    f.pitch = -(Math.PI / 2 - 0.02)
    const u = centre().pos
    const dug = fp!.dig()
    const under = e.world.get(u[0], u[1], u[2])
    return { refused, placed, aheadIsStone: ahead === stone, dug, under }
  })
  expect(r).toEqual({ refused: false, placed: true, aheadIsStone: true, dug: true, under: 0 })

  await page.keyboard.press('c')
  const back = await page.evaluate(() => {
    const e = (window as W).__elovox!.engine
    return { mode: e.cameraMode, fov: e.camera.fov, target: [...e.controls.goal.target], pos: [...e.firstPerson.position] }
  })
  expect(back).toMatchObject({ mode: 'orbit', fov: 50 })
  expect(back.target[0]).toBeCloseTo(back.pos[0]!, 5)
  expect(back.target[2]).toBeCloseTo(back.pos[2]!, 5)
  expect(errors).toEqual([])
})

test('first person in a units scene: look and walk, no dig/place, clicks submit nothing', async ({ page }) => {
  const errors = watchErrors(page)
  await boot(page, '/?scene=workers&still')
  await page.keyboard.press('c')
  await page.evaluate(() => {
    const e = (window as W).__elovox!.engine as Engine & { __submits?: number }
    const submit = e.submit.bind(e)
    e.__submits = 0
    e.submit = (c) => { e.__submits!++; return submit(c) }
  })
  const box = (await page.locator('canvas').boundingBox())!
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  const r = await page.evaluate(() => {
    const { engine, fp } = (window as W).__elovox!
    return { mode: engine.cameraMode, dug: fp!.dig(), placed: fp!.place(), submits: (engine as Engine & { __submits?: number }).__submits }
  })
  expect(r).toEqual({ mode: 'firstPerson', dug: false, placed: false, submits: 0 })
  expect(errors).toEqual([])
})
