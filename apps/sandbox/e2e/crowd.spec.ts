import { expect, test } from '@playwright/test'
import type { Engine } from '@elovox/engine'
import type { Crowd } from '../src/crowdScript.ts'
import { WORKER_STATES } from '@elovox/engine/src/sim/workers/types.ts'
import { PADS } from '../src/scenes/crowd.ts'

type W = Window & { __elovox?: { engine: Engine; crowd: Crowd | null; ready: boolean } }

test('the crowd scene sends 50 units from the west and north pads toward the east pad', async ({ page }) => {
  test.setTimeout(600_000)
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto('/?scene=crowd&units=50')
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 300_000 })
  await page.evaluate(() => (window as W).__elovox!.crowd!.spawn())
  expect(await page.evaluate(() => (window as W).__elovox!.crowd!.ids().length)).toBe(50)
  await page.evaluate(() => (window as W).__elovox!.crowd!.allEast())
  // Walking, or idle on the east pad: poses are [id, x256, y256, z256, facing, state, …] every 9 values.
  const east = PADS.east
  const progressing = () => page.evaluate(([x0, x1, z0, z1, idle, walking]) => {
    const p = (window as W).__elovox!.engine.workers?.poses ?? new Int32Array(0)
    let n = 0
    for (let i = 0; i < p.length; i += 9) {
      const x = p[i + 1]! / 256, z = p[i + 3]! / 256, state = p[i + 5]!
      if (state === walking || state === idle && x >= x0! && x < x1! + 1 && z >= z0! && z < z1! + 1) n++
    }
    return n
  }, [east.min[0], east.max[0], east.min[2], east.max[2], WORKER_STATES.indexOf('idle'), WORKER_STATES.indexOf('walking')])
  await expect.poll(progressing, { timeout: 30_000, intervals: [500] }).toBeGreaterThanOrEqual(45)
  expect(errors).toEqual([])
})
