import { test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { Engine } from '@elovox/engine'

type W = Window & { __elovox?: { engine: Engine; ready: boolean } }
test.skip(!process.env.BENCH_VIEW, 'set BENCH_VIEW=1 for the view-distance benchmark')

/** Camera poses: orbit target (x, z; y comes from the terrain), yaw, pitch, distance. */
const POSES: Record<string, { at: [number, number]; yaw: number; pitch: number; distance: number }> = {
  'orbit-default': { at: [0.5, 0.5], yaw: 0.7, pitch: 0.85, distance: 70 },
  'orbit-far': { at: [0.5, 0.5], yaw: 0.7, pitch: 0.85, distance: 400 },
  'orbit-far-low': { at: [0.5, 0.5], yaw: 0.7, pitch: 0.3, distance: 400 },
  // Near-first-person: 1–2 blocks above the ground, looking across the world's diagonal to the far corner.
  'ground-horizon': { at: [0.12, 0.12], yaw: -3 * Math.PI / 4, pitch: 0.15, distance: 8 },
}
const WINDOW_MS = Number(process.env.VIEW_WINDOW_MS ?? 8000)

async function settle(page: Page, ms: number): Promise<boolean> {
  return page.waitForFunction(() => { const s = (window as W).__elovox!.engine.stats(); return s.meshQueue === 0 && s.meshInFlight === 0 }, null, { timeout: ms })
    .then(() => true, () => false)
}

async function measure(page: Page, windowMs: number) {
  return page.evaluate(async (windowMs) => {
    const e = (window as W).__elovox!.engine
    const frames: number[] = [], cpu: number[] = []
    let gpu: number | null = null, draws = 0, triangles = 0
    let last = performance.now(), done = false
    const loop = (now: number) => {
      if (done) return
      frames.push(now - last); last = now
      const s = e.stats()
      cpu.push(s.frameMs); if (s.gpuMs !== null) gpu = s.gpuMs
      draws = Math.max(draws, s.drawCalls)
      triangles = Math.max(triangles, (e.renderer.info.render as { triangles: number }).triangles)
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
    await new Promise(r => setTimeout(r, windowMs))
    done = true
    frames.shift()
    const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))]! : 0 }
    const r = (v: number) => Math.round(v * 100) / 100
    return { frames: frames.length, fpsMedian: r(1000 / q(frames, .5)), fpsP5: r(1000 / q(frames, .95)), cpuMedian: r(q(cpu, .5)), cpuP95: r(q(cpu, .95)), gpuMs: gpu, draws, triangles }
  }, windowMs)
}

test('view distance: frame cost per camera pose', async ({ page }, info) => {
  test.setTimeout(1_200_000)
  await page.setViewportSize({ width: 1920, height: 889 })
  const query = process.env.VIEW_QUERY ?? 'size=1024&gpu'
  await page.goto(`/?${query}`)
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 300_000 })
  if (!await settle(page, 300_000)) throw new Error('the world never finished its first meshing')
  const out: Record<string, unknown> = {}
  // Scene composition: render objects by kind (name prefix up to the first '-' or digit), all and visible.
  out.composition = await page.evaluate(() => {
    const e = (window as W).__elovox!.engine
    const kinds: Record<string, { all: number; visible: number }> = {}
    e.scene.traverse(o => {
      const m = o as { isMesh?: boolean; isBatchedMesh?: boolean; isLine?: boolean; isPoints?: boolean; isSprite?: boolean }
      if (!m.isMesh && !m.isLine && !m.isPoints && !m.isSprite) return
      const kind = `${m.isBatchedMesh ? 'batch:' : ''}${(o.name || o.type).replace(/[-_]?\d.*$/, '')}`
      let visible = true
      for (let p: typeof o | null = o; p; p = p.parent) if (!p.visible) { visible = false; break }
      const k = kinds[kind] ??= { all: 0, visible: 0 }
      k.all++; if (visible) k.visible++
    })
    let objects = 0
    e.scene.traverse(() => { objects++ })
    return { objects, kinds }
  })
  for (const [name, p] of Object.entries(POSES)) {
    await page.bringToFront()
    await page.evaluate(p => {
      const e = (window as W).__elovox!.engine
      const [sx, , sz] = e.layout.size
      for (const s of [e.controls.goal, e.controls.current]) {
        s.target[0] = p.at[0] * sx; s.target[2] = p.at[1] * sz; s.yaw = p.yaw; s.pitch = p.pitch; s.distance = p.distance
      }
    }, p)
    await page.waitForTimeout(2000)
    await settle(page, 10_000)
    if (process.env.VIEW_PROFILE) {
      // VIEW_PROFILE=dir: a main-thread CPU profile of each pose's window, for bench/topSelf.node.mjs.
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Profiler.enable'); await cdp.send('Profiler.start')
      out[name] = await measure(page, WINDOW_MS)
      const { profile } = await cdp.send('Profiler.stop')
      mkdirSync(process.env.VIEW_PROFILE, { recursive: true })
      writeFileSync(`${process.env.VIEW_PROFILE}/view-${name}.cpuprofile`, JSON.stringify(profile))
    } else out[name] = await measure(page, WINDOW_MS)
    mkdirSync('test-results', { recursive: true })
    await page.screenshot({ path: `test-results/view-${name}.png` })
  }
  const result = { date: new Date().toISOString(), query, userAgent: await page.evaluate(() => navigator.userAgent), poses: out }
  const path = process.env.VIEW_BENCH_OUT ?? 'test-results/view-bench.json'
  writeFileSync(path, JSON.stringify(result, null, 2))
  await info.attach('view-bench', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
})
