import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Engine } from '@elovox/engine'
import type { Living } from '../src/livingScript.ts'

type W = Window & { __elovox?: { engine: Engine; living: Living | null; ready: boolean } }
type Phase = 'idle-default' | 'idle-far' | 'work-default' | 'work-far' | 'dam' | 'collapse'
type PhaseResult = Record<string, unknown> & { phase: Phase; fpsP5: number; fpsMedian: number; cpuP95: number; tickP95: number; applyP95: number; gpuMs: number | null }
test.skip(!process.env.BENCH_LIVING, 'set BENCH_LIVING=1 for the living-world benchmark')

const TARGETS = { fpsP5: 60, tickP95: 10, applyP95: 4 }
/** LIVING_BENCH_SHORT=1 shrinks every window tenfold, for smoke checks of the benchmark itself. */
const SCALE = process.env.LIVING_BENCH_SHORT ? 0.1 : 1
/** Phase script (spec §4): [phase, camera, event fired before the window, window ms]. */
const SCRIPT: [Phase, 'default' | 'far' | 'dam' | 'tower', 'startWork' | 'breach' | 'collapse' | null, number][] = [
  ['idle-default', 'default', null, 10_000], ['idle-far', 'far', null, 10_000],
  ['work-default', 'default', 'startWork', 30_000], ['work-far', 'far', null, 30_000],
  ['dam', 'dam', 'breach', 45_000], ['collapse', 'tower', 'collapse', 20_000],
]

/** Waits for the mesh queue to drain; active phases (water, work, random ticks) may never reach zero, so give up after `ms`. */
async function settle(page: Page, ms: number): Promise<boolean> {
  return page.waitForFunction(() => { const s = (window as W).__elovox!.engine.stats(); return s.meshQueue === 0 && s.meshInFlight === 0 }, null, { timeout: ms })
    .then(() => true, () => false)
}

async function measure(page: Page, phase: Phase, windowMs: number): Promise<PhaseResult> {
  return page.evaluate(async ({ phase, windowMs }) => {
    const e = (window as W).__elovox!.engine
    const frames: number[] = [], cpu: number[] = [], ticks: number[] = [], applies: number[] = []
    let gpu: number | null = null, maxDraws = 0, maxShadowCasters = 0, maxDecorationInstances = 0, maxSearches = 0, maxFragments = 0, maxWaterColumns = 0, maxMeshQueue = 0
    const offTick = e.on('tick', t => { ticks.push(t.tickMs); applies.push(e.stats().waterApplyMs) })
    let last = performance.now(), done = false
    const loop = (now: number) => {
      if (done) return
      frames.push(now - last); last = now
      const s = e.stats()
      cpu.push(s.frameMs); if (s.gpuMs !== null) gpu = s.gpuMs
      maxDraws = Math.max(maxDraws, s.drawCalls); maxShadowCasters = Math.max(maxShadowCasters, s.shadowCasters)
      maxDecorationInstances = Math.max(maxDecorationInstances, s.decorationInstances); maxSearches = Math.max(maxSearches, s.workers?.searches ?? 0)
      maxFragments = Math.max(maxFragments, s.collapseFragments); maxWaterColumns = Math.max(maxWaterColumns, s.waterColumns)
      maxMeshQueue = Math.max(maxMeshQueue, s.meshQueue + s.meshInFlight)
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
    await new Promise(r => setTimeout(r, windowMs))
    done = true; offTick()
    frames.shift()
    const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))]! : 0 }
    const states: Record<string, number> = {}
    const poses = e.workers?.poses ?? new Int32Array()
    const names = ['idle', 'planning', 'walking', 'working', 'blocked', 'falling', 'incapacitated']
    for (let i = 5; i < poses.length; i += 9) { const n = names[poses[i]!]!; states[n] = (states[n] ?? 0) + 1 }
    const r = (v: number) => Math.round(v * 100) / 100
    return {
      phase, windowMs, frames: frames.length, fpsMedian: r(1000 / q(frames, .5)), fpsP5: r(1000 / q(frames, .95)), fpsMin: r(1000 / Math.max(...frames)),
      cpuMedian: r(q(cpu, .5)), cpuP95: r(q(cpu, .95)), gpuMs: gpu, ticks: ticks.length, tickP95: r(q(ticks, .95)), tickMax: r(Math.max(0, ...ticks)),
      applyP95: r(q(applies, .95)), applyMax: r(Math.max(0, ...applies)),
      maxDraws, maxShadowCasters, maxDecorationInstances, maxSearches, maxFragments, maxWaterColumns, maxMeshQueue, unitStates: states,
    }
  }, { phase, windowMs }) as Promise<PhaseResult>
}

async function profile<T>(page: Page, name: string, body: () => Promise<T>): Promise<T> {
  if (!process.env.LIVING_PROFILE) return body()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Profiler.enable'); await cdp.send('Profiler.start')
  try { return await body() } finally {
    const { profile } = await cdp.send('Profiler.stop')
    mkdirSync('test-results', { recursive: true }); writeFileSync(`test-results/living-${name}.cpuprofile`, JSON.stringify(profile))
  }
}

async function run(page: Page): Promise<PhaseResult[]> {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto('/?scene=living&gpu')
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 300_000 })
  // The river and the sea never sleep, so physics is never idle: a fixed warm-up lets the set pieces' first edits pass.
  await page.waitForTimeout(10_000 * SCALE)
  if (!await settle(page, 120_000)) throw new Error('the living scene never finished its first meshing')
  const out: PhaseResult[] = []
  for (const [phase, camera, event, windowMs] of SCRIPT) {
    await page.evaluate(c => (window as W).__elovox!.living!.camera(c), camera)
    if (event) await page.evaluate(ev => (window as W).__elovox!.living![ev](), event)
    await page.waitForTimeout(2000)
    const settled = await settle(page, 10_000)
    out.push({ ...await profile(page, phase, () => measure(page, phase, windowMs * SCALE)), settled })
  }
  expect(errors).toEqual([])
  return out
}

test('living world, every phase, worse of two runs', async ({ page }, info) => {
  test.setTimeout(1_800_000)
  await page.setViewportSize({ width: 1920, height: 889 })
  const runs = [await run(page), await run(page)]
  const worst = Object.fromEntries(runs[0]!.map((a, i) => {
    const b = runs[1]![i]!
    return [a.phase, { ...a, fpsP5: Math.min(a.fpsP5, b.fpsP5), fpsMedian: Math.min(a.fpsMedian, b.fpsMedian), cpuP95: Math.max(a.cpuP95, b.cpuP95), tickP95: Math.max(a.tickP95, b.tickP95), applyP95: Math.max(a.applyP95, b.applyP95) }]
  })) as Record<Phase, PhaseResult>
  const pass = Object.fromEntries(Object.values(worst).map(p => [p.phase, p.fpsP5 >= TARGETS.fpsP5 && p.tickP95 <= TARGETS.tickP95 && p.applyP95 <= TARGETS.applyP95]))
  const result = { date: new Date().toISOString(), userAgent: await page.evaluate(() => navigator.userAgent), runs, worst, targets: TARGETS, pass }
  const path = process.env.LIVING_BENCH_OUT ?? 'test-results/living-bench.json'
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(result, null, 2))
  await info.attach('living-performance', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
  if (process.env.BENCH_ASSERT) {
    expect(Object.values(worst).every(p => p.gpuMs !== null)).toBe(true)
    expect(pass).toEqual(Object.fromEntries(SCRIPT.map(([p]) => [p, true])))
  }
})
