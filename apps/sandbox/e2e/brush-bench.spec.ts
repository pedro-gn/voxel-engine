import { test } from '@playwright/test'
import type { Engine } from '@elovox/engine'
import type { TerrainEditor } from '@elovox/terrain-editor'

type W = Window & { __elovox?: { engine: Engine; editor: TerrainEditor | null; ready: boolean } }

test.skip(!process.env.BENCH, 'set BENCH=1 to run the brush benchmark')

test('brush stroke: request → visible mesh per update, radius 16, before and after painting 512²', async ({ page }) => {
  test.setTimeout(600_000)
  await page.goto('/?scene=terrain&edit') // the 1024² showcase
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 180_000 })

  /** 20 moves of a radius-16 raise stroke; each waits until its update is visible. */
  const stroke = () => page.evaluate(async () => {
    const ed = (window as W).__elovox!.editor!
    const b = ed.brushes
    b.setMode('height')
    b.setTool('raise')
    b.setSettings({ radius: 16, strength: 0.3, falloff: 0.5 })
    const settled = async (prev: unknown) => {
      const start = performance.now()
      for (;;) {
        await new Promise((r) => requestAnimationFrame(r))
        if (performance.now() - start > 60_000) throw new Error(`no update became visible within 60 s; last status: ${JSON.stringify(ed.preview.status)}`)
        const s = ed.preview.status
        if (s.state === 'idle' && s.last && s.last !== prev && s.last.meshFrames !== undefined) return s.last
      }
    }
    const first = ed.preview.status
    let prev: unknown = first.state === 'idle' ? first.last : null
    const out: number[] = []
    b.begin({ x: 400, y: 0, z: 500 }, false)
    for (let i = 1; i <= 20; i++) {
      b.move({ x: 400 + i * 8, y: 0, z: 500 }, false)
      const last = await settled(prev)
      prev = last
      out.push(last.wallMs)
    }
    b.end()
    await ed.preview.idle()
    return out
  })
  const summary = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b)
    return { median: Math.round(s[Math.floor(s.length / 2)]!), p90: Math.round(s[Math.floor(s.length * 0.9)]!), max: Math.round(s.at(-1)!) }
  }

  const fresh = await stroke()
  await page.evaluate(async () => {
    const ed = (window as W).__elovox!.editor!
    const tiles: { x: number; z: number; values: Int16Array }[] = []
    for (let z = 4; z < 12; z++) for (let x = 4; x < 12; x++) tiles.push({ x, z, values: new Int16Array(4096).fill(16) })
    ed.session.apply('prepaint 512²', (d) => ({ ...d, layers: { ...d.layers, height: { tiles } } }))
    await ed.preview.idle()
  })
  const painted = await stroke()
  console.log(`brush bench (ms, request → visible mesh): fresh ${JSON.stringify(summary(fresh))}, after 512² painted ${JSON.stringify(summary(painted))}`)
})
