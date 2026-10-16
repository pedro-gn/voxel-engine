import { expect, test } from '@playwright/test'

for (const backend of ['webgpu', 'webgl'] as const) for (const elevation of [13, 30, 48]) {
  test(`${backend}, sun at ${elevation}°: flat voxel ground stays free of moving shadow bands`, async ({ page }, info) => {
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
    await page.route('**/bands-test', route => route.fulfill({ contentType: 'text/html', body: '<canvas></canvas>' }))
    await page.goto('/bands-test')
    if (backend === 'webgpu') {
      const available = await page.evaluate(async () => {
        const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
        return !!(await gpu?.requestAdapter())
      })
      test.skip(!available, 'This browser has no WebGPU adapter')
    }
    const result = await page.evaluate(async ({ backend, elevation }) => {
      const path = '/e2e/fixtures/shadow-bands.ts'
      const { renderBands } = await import(/* @vite-ignore */ path)
      return {
        control: await renderBands(backend === 'webgl', elevation, false),
        shadowed: await renderBands(backend === 'webgl', elevation),
      }
    }, { backend, elevation })
    await page.locator('canvas').screenshot({ path: info.outputPath('flat-ground.png') })
    expect(result.shadowed.range, 'brightness variation on a uniformly lit flat voxel face').toBeLessThanOrEqual(1)
    expect(result.control.min).toBeGreaterThan(20)
    expect(Math.abs(result.shadowed.min - result.control.min), 'self-shadowing on a surface with no occluders').toBeLessThanOrEqual(1)
    expect(errors).toEqual([])
  })
}
