import { expect, test } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { MAX_DIFF_SHARE, pixelDiff, shoot, type Pose } from './shots.ts'

/**
 * The 512² e2e terrain, frozen (?still): 16 × 16 chunk columns, so 4 regions of 8 × 8 per batched layer, with trees whose
 * leaves are the cutout layer. Remeshes, appends and compaction are covered by chunkBatches.test.ts.
 */
const SCENE = '/?scene=terrain&size=512&still'
const POSE: Pose = { t: [256, 40, 256], d: 420, p: 0.75, y: 0.7 }

for (const backend of ['webgpu', 'webgl'] as const) {
  test(`${backend}: batched and unbatched chunks draw the same picture`, async ({ page }, info) => {
    test.setTimeout(240_000)
    await page.setViewportSize({ width: 1280, height: 720 })
    const flag = backend === 'webgl' ? '&webgl' : ''
    const batched = await shoot(page, SCENE + flag, POSE)
    const unbatched = await shoot(page, SCENE + flag + '&nobatch', POSE)
    const diff = await pixelDiff(page, batched.png, unbatched.png)
    writeFileSync(info.outputPath('batched.png'), batched.png)
    writeFileSync(info.outputPath('unbatched.png'), unbatched.png)
    writeFileSync(info.outputPath('diff.png'), Buffer.from(diff.mask, 'base64'))
    console.log(`batching pixel diff (${batched.backend}): ${(diff.share * 100).toFixed(4)}% (${diff.differing} / ${diff.pixels}); batches ${JSON.stringify(batched.batches)}; cutout meshes unbatched ${unbatched.cutoutMeshes}; shadow casters ${batched.shadowCasters} batched vs ${unbatched.shadowCasters}; meshes ${batched.meshes} vs ${unbatched.meshes}`)
    expect(batched.camera).toEqual(unbatched.camera) // the same pose to the bit
    expect(batched.backend).toBe(backend)
    expect(unbatched.backend).toBe(backend)
    // The picture spans several regions and includes the cutout layer.
    expect(batched.batches.opaque).toBeGreaterThan(1)
    expect(batched.batches.cutout).toBeGreaterThan(0)
    expect(unbatched.cutoutMeshes).toBeGreaterThan(0)
    expect(diff.share).toBeLessThan(MAX_DIFF_SHARE)
    expect(batched.meshes).toBe(unbatched.meshes) // the same chunk layers, however they are drawn
    expect(batched.shadowCasters).toBeLessThan(unbatched.shadowCasters)
    expect(batched.errors).toEqual([]) // NaN bounding-sphere errors would land here
    expect(unbatched.errors).toEqual([])
  })

  // Spec 4b §4.1: the engine's batch cull (precomputed spheres, no sort, both passes) against three's own (?cull=three).
  for (const [label, scene, pose] of [
    ['512² orbit', SCENE, POSE],
    ['1024² far', '/?scene=terrain&size=1024&still', { t: [512, 50, 512], d: 400, p: 0.3, y: 0.7 }],
  ] as const) {
    test(`${backend}: the engine's cull draws the picture three's cull draws (${label})`, async ({ page }, info) => {
      test.setTimeout(400_000)
      await page.setViewportSize({ width: 1280, height: 720 })
      const flag = backend === 'webgl' ? '&webgl' : ''
      const ours = await shoot(page, scene + flag, pose)
      const three = await shoot(page, scene + flag + '&cull=three', pose)
      const diff = await pixelDiff(page, ours.png, three.png)
      writeFileSync(info.outputPath('ours.png'), ours.png)
      writeFileSync(info.outputPath('three.png'), three.png)
      writeFileSync(info.outputPath('diff.png'), Buffer.from(diff.mask, 'base64'))
      console.log(`cull pixel diff (${ours.backend}, ${label}): ${(diff.share * 100).toFixed(4)}% (${diff.differing} / ${diff.pixels})`)
      expect(ours.camera).toEqual(three.camera)
      expect(ours.backend).toBe(backend)
      expect(diff.share).toBeLessThan(MAX_DIFF_SHARE)
      expect(ours.errors).toEqual([])
      expect(three.errors).toEqual([])
    })
  }
}
