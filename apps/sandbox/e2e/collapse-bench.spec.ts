import { expect, test } from '@playwright/test'
import type { Engine } from '@elovox/engine'
type W = Window & { __elovox?: { engine: Engine; collapse: { stress(): void }; ready: boolean } }
test.skip(!process.env.BENCH_COLLAPSE, 'set BENCH_COLLAPSE=1 for the production collapse performance check')

for (const run of [1, 2]) test(`9,216-cell collapse peak, window ${run}`, async ({ page }, info) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto('/?scene=collapse&stress')
  await page.waitForFunction(() => (window as W).__elovox?.ready, null, { timeout: 120_000 })
  await page.waitForFunction(() => { const s = (window as W).__elovox!.engine.stats(); return !s.physicsBusy && s.meshQueue === 0 && s.meshInFlight === 0 && s.fps > 0 })
  // Compile the fragment material before measuring the sustained peak; initialization is separate.
  await page.evaluate(() => { const e = (window as W).__elovox!.engine; e.submit({ type: 'setBlock', pos: [6, 12, 120], voxel: e.blocks.id('structural_planks') }) })
  await page.waitForFunction(() => { const e = (window as W).__elovox!.engine; return e.world.get(6, 4, 120) === e.blocks.id('structural_planks') && !e.stats().physicsBusy && e.stats().meshQueue === 0 && e.stats().meshInFlight === 0 && !e.scene.getObjectByName('elovox-fragments')?.children.length })
  const result = await page.evaluate(async () => {
    const e = (window as W).__elovox!.engine, ticks: number[] = [], frames: number[] = []
    let done = false, frameAt = performance.now(), peakFragments = 0, maxVisited = 0, maxMutations = 0, movingFrames = 0, renderPeak = 0
    const stop = e.on('tick', ({ tickMs }) => { ticks.push(tickMs); const s = e.stats(); peakFragments = Math.max(peakFragments, s.collapseFragments); maxVisited = Math.max(maxVisited, s.collapseVisited); maxMutations = Math.max(maxMutations, s.collapseMutations) })
    function frame(now: number) {
      if (done) return
      frames.push(now - frameAt); frameAt = now
      const group = e.scene.getObjectByName('elovox-fragments')
      renderPeak = Math.max(renderPeak, group?.children.length ?? 0)
      if (group?.children.some(b => b.position.y < -.5)) movingFrames++
      requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
    const start = performance.now(); (window as W).__elovox!.collapse.stress()
    await new Promise<void>((resolve, reject) => {
      const poll = () => {
        if (performance.now() - start > 90_000) { reject(new Error('collapse did not finish its peak window')); return }
        if (ticks.length >= 10 && !e.stats().physicsBusy) { resolve(); return }
        setTimeout(poll, 50)
      }; poll()
    })
    done = true; stop()
    ticks.sort((a, b) => a - b); frames.sort((a, b) => a - b)
    return { backend: e.stats().backend, durationMs: performance.now() - start, ticks: ticks.length, frames: frames.length,
      tickP95: ticks[Math.ceil(ticks.length * .95) - 1], tickMax: ticks.at(-1), fpsP5: 1000 / frames[Math.ceil(frames.length * .95) - 1],
      minFps: 1000 / frames.at(-1)!, peakFragments, maxVisited, maxMutations, movingFrames, renderPeak }
  })
  await info.attach('collapse-performance', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
  expect(result.maxVisited).toBeLessThanOrEqual(4096); expect(result.maxMutations).toBeLessThanOrEqual(128)
  expect(result.peakFragments).toBeLessThanOrEqual(64); expect(result.ticks).toBeGreaterThan(10)
  expect(result.movingFrames).toBeGreaterThan(10)
  expect(errors).toEqual([])
  if (process.env.BENCH_ASSERT) { expect(result.backend).toBe('webgpu'); expect(result.tickP95).toBeLessThanOrEqual(10); expect(result.fpsP5).toBeGreaterThanOrEqual(45) }
})
