import { expect, test, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import type { Engine } from '@elovox/engine'
import type { Character } from '../src/character.ts'

type W = Window & { __elovox?: { engine: Engine; bean: Character | null; ready: boolean } }

/** A share of pixels this large differing by more than CHANNEL_TOLERANCE on any channel means the picture changed. */
const MAX_DIFF_SHARE = 0.005
const CHANNEL_TOLERANCE = 8

interface Shot { png: Buffer; shadowCasters: number; meshes: number; backend: string; errors: string[] }

/** Boots the world frozen (?still), hides what animates and is not a chunk, frames a fixed camera, and screenshots it. */
async function shoot(page: Page, url: string): Promise<Shot> {
  const errors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(url)
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 90_000 })
  await page.evaluate(() => {
    const { engine, bean } = (window as W).__elovox!
    engine.effects = { decorations: false } // animated grass would differ between the two loads
    if (bean) bean.root.visible = false // so would the idle animation
    for (const s of [engine.controls.goal, engine.controls.current]) {
      s.target[0] = 64; s.target[1] = 30; s.target[2] = 64
      s.distance = 150; s.pitch = 0.7; s.yaw = 0.7
    }
    engine.controls.apply(engine.camera)
  })
  await page.waitForFunction(() => { const s = (window as W).__elovox!.engine.stats(); return s.meshQueue + s.meshInFlight === 0 }, null, { timeout: 60_000 })
  await page.waitForTimeout(1000)
  const stats = await page.evaluate(() => (window as W).__elovox!.engine.stats())
  const png = await page.screenshot({ type: 'png' })
  page.removeAllListeners('console')
  page.removeAllListeners('pageerror')
  return { png, shadowCasters: stats.shadowCasters, meshes: stats.meshes, backend: stats.backend, errors }
}

test('batched and unbatched chunks draw the same picture', async ({ page }, info) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  const batched = await shoot(page, '/?size=128&still')
  const unbatched = await shoot(page, '/?size=128&still&nobatch')
  // No PNG decoder in the repo: decode both screenshots in the page and compare their pixels there. Differing pixels
  // come back as a red-on-black mask.
  const diff = await page.evaluate(async ({ a, b, tolerance }) => {
    const decode = async (b64: string) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob())
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      return ctx.getImageData(0, 0, bitmap.width, bitmap.height)
    }
    const [x, y] = await Promise.all([decode(a), decode(b)])
    if (x.width !== y.width || x.height !== y.height) return { share: 1, differing: -1, pixels: 0, mask: '' }
    const mask = new ImageData(x.width, x.height)
    let differing = 0
    for (let i = 0; i < x.data.length; i += 4) {
      mask.data[i + 3] = 255
      for (let c = 0; c < 4; c++) {
        if (Math.abs(x.data[i + c]! - y.data[i + c]!) > tolerance) { differing++; mask.data[i] = 255; break }
      }
    }
    const canvas = new OffscreenCanvas(x.width, x.height)
    canvas.getContext('2d')!.putImageData(mask, 0, 0)
    const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
    let bin = ''
    for (const v of bytes) bin += String.fromCharCode(v)
    const pixels = x.width * x.height
    return { share: differing / pixels, differing, pixels, mask: btoa(bin) }
  }, { a: batched.png.toString('base64'), b: unbatched.png.toString('base64'), tolerance: CHANNEL_TOLERANCE })
  writeFileSync(info.outputPath('batched.png'), batched.png)
  writeFileSync(info.outputPath('unbatched.png'), unbatched.png)
  writeFileSync(info.outputPath('diff.png'), Buffer.from(diff.mask, 'base64'))
  console.log(`batching pixel diff (${batched.backend}): ${(diff.share * 100).toFixed(4)}% (${diff.differing} / ${diff.pixels}); shadow casters ${batched.shadowCasters} batched vs ${unbatched.shadowCasters}; meshes ${batched.meshes} vs ${unbatched.meshes}`)
  expect(diff.share).toBeLessThan(MAX_DIFF_SHARE)
  expect(batched.backend).toBe(unbatched.backend)
  expect(batched.meshes).toBe(unbatched.meshes) // the same chunk layers, however they are drawn
  expect(batched.shadowCasters).toBeLessThan(unbatched.shadowCasters)
  expect(batched.errors).toEqual([]) // NaN bounding-sphere errors would land here
  expect(unbatched.errors).toEqual([])
})
