import { expect, test } from '@playwright/test'

for (const backend of ['webgl', 'webgpu'] as const) for (const terrace of [false, true]) {
  test(`${backend}: ${terrace ? 'terrace' : 'thin wall'} shadows meet the floor without a bright contact seam`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    await page.route('**/shadow-test', (route) => route.fulfill({
      contentType: 'text/html', body: '<html><body style="margin:0"><canvas></canvas></body></html>',
    }))
    await page.goto('/shadow-test')
    if (backend === 'webgpu') {
      const available = await page.evaluate(async () => {
        const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
        return !!(await gpu?.requestAdapter())
      })
      test.skip(!available, 'This browser has no WebGPU adapter')
    }
    const result = await page.evaluate(async ({ backend, terrace }) => {
      const path = '/e2e/fixtures/shadow-contact.ts'
      const { renderContact } = await import(/* @vite-ignore */ path)
      return renderContact(backend === 'webgl', terrace) as Promise<{
        backend: string; samples: { dx: number; light: number }[]; sunlit: number[]
      }>
    }, { backend, terrace })
    const screenshot = testInfo.outputPath('contact.png')
    await page.locator('canvas').screenshot({ path: screenshot })
    await testInfo.attach('contact', { path: screenshot, contentType: 'image/png' })
    expect(result.backend).toBe(backend)
    const { samples, sunlit } = result
    const interior = samples.find((s) => s.dx === 0.64)!.light
    for (const s of samples.filter((s) => s.dx <= 0.16)) {
      expect(s.light, `floor ${s.dx} blocks from the wall`).toBeLessThanOrEqual(interior + 0.03)
    }
    expect(interior).toBeLessThan(0.15)
    for (const light of sunlit) expect(light, 'sunlit top stays free of shadow acne').toBeGreaterThan(0.7)
    expect(errors).toEqual([])
  })
}
