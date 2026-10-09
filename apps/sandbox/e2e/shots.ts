import type { Page } from '@playwright/test'
import type { Engine } from '@elovox/engine'

type W = Window & { __elovox?: { engine: Engine; ready: boolean } }

/** A share of pixels this large differing by more than CHANNEL_TOLERANCE on any channel means the picture changed. */
export const MAX_DIFF_SHARE = 0.005
export const CHANNEL_TOLERANCE = 8

export interface Shot { camera: number[]; png: Buffer; shadowCasters: number; meshes: number; backend: string; batches: Record<string, number>; cutoutMeshes: number; errors: string[] }
export interface Pose { t: readonly [number, number, number]; d: number; p: number; y: number }
export const DEFAULT_POSE: Pose = { t: [128, 40, 128], d: 260, p: 0.75, y: 0.7 }

/** The view bench's camera poses: orbit target (x, z as a share of the world; y comes from the terrain), yaw, pitch, distance. */
export const VIEW_POSES: Record<string, { at: [number, number]; yaw: number; pitch: number; distance: number }> = {
  'orbit-default': { at: [0.5, 0.5], yaw: 0.7, pitch: 0.85, distance: 70 },
  'orbit-far': { at: [0.5, 0.5], yaw: 0.7, pitch: 0.85, distance: 400 },
  'orbit-far-low': { at: [0.5, 0.5], yaw: 0.7, pitch: 0.3, distance: 400 },
  // Near-first-person: 1–2 blocks above the ground, looking across the world's diagonal to the far corner.
  'ground-horizon': { at: [0.12, 0.12], yaw: -3 * Math.PI / 4, pitch: 0.15, distance: 8 },
}

/** Boots the scene, hides what animates and is not a chunk, frames a fixed camera, and screenshots the canvas alone. */
export async function shoot(page: Page, url: string, pose: Pose = DEFAULT_POSE): Promise<Shot> {
  const errors: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
    // Batching follow-up: the batch geometry aliases `normal`, so three's batch node no longer warns once per batch build.
    if (/Vertex attribute "normal" not found/.test(m.text())) errors.push(`warning: ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(url)
  await page.waitForFunction(() => (window as W).__elovox?.ready === true, null, { timeout: 240_000 })
  await page.evaluate((pose) => {
    const { engine } = (window as W).__elovox!
    engine.effects = { decorations: false } // animated grass would differ between the two loads
    // So would drifting clouds and the animated water surface (the 1024² showcase has a lake and a river); the chunks are
    // what these tests compare.
    engine.atmosphere.set({ sky: { clouds: { speed: 0 } } })
    const water = engine.scene.getObjectByName('elovox-water')
    if (water) water.visible = false
    for (const s of [engine.controls.goal, engine.controls.current]) {
      s.target[0] = pose.t[0]; s.target[1] = pose.t[1]; s.target[2] = pose.t[2]
      s.distance = pose.d; s.pitch = pose.p; s.yaw = pose.y
    }
    engine.controls.apply(engine.camera)
    // The HUD and panels sit over the canvas (the HUD's fps text changes every frame): hide all but the canvas.
    const view = document.querySelector('#view')!
    for (const el of document.querySelectorAll<HTMLElement>('body *')) if (el !== view && !el.contains(view)) el.style.visibility = 'hidden'
  }, pose)
  await page.waitForFunction(() => { const s = (window as W).__elovox!.engine.stats(); return s.meshQueue + s.meshInFlight === 0 }, null, { timeout: 240_000 })
  // The orbit camera re-targets its goal to the terrain height every frame and damps toward it, so how close it got
  // depends on frame timing: a sub-pixel shift that speckles the whole picture. Snap it onto the goal; it then stays.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await page.evaluate(() => {
    const { controls, camera } = (window as W).__elovox!.engine
    const { goal, current } = controls
    current.target[0] = goal.target[0]; current.target[1] = goal.target[1]; current.target[2] = goal.target[2]
    current.yaw = goal.yaw; current.pitch = goal.pitch; current.distance = goal.distance
    controls.apply(camera)
  })
  await page.waitForTimeout(1000)
  const info = await page.evaluate(() => {
    const e = (window as W).__elovox!.engine
    const batches: Record<string, number> = {}
    let cutoutMeshes = 0
    e.scene.traverse((o) => {
      if ((o as { isBatchedMesh?: boolean }).isBatchedMesh) { const layer = o.name.split('-')[1]!; batches[layer] = (batches[layer] ?? 0) + 1 }
      if (/^chunk-\d+-cutout$/.test(o.name)) cutoutMeshes++
    })
    return { stats: e.stats(), batches, cutoutMeshes, camera: e.camera.matrixWorld.toArray() }
  })
  const png = await page.locator('#view').screenshot({ type: 'png' })
  page.removeAllListeners('console')
  page.removeAllListeners('pageerror')
  const s = info.stats
  return { camera: info.camera, png, shadowCasters: s.shadowCasters, meshes: s.meshes, backend: s.backend, batches: info.batches, cutoutMeshes: info.cutoutMeshes, errors }
}

/**
 * No PNG decoder in the repo: decodes both screenshots in the page and compares their pixels there. Differing pixels come
 * back as a red-on-black mask.
 */
export function pixelDiff(page: Page, a: Buffer, b: Buffer): Promise<{ share: number; differing: number; pixels: number; mask: string }> {
  return page.evaluate(async ({ a, b, tolerance }) => {
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
  }, { a: a.toString('base64'), b: b.toString('base64'), tolerance: CHANNEL_TOLERANCE })
}
