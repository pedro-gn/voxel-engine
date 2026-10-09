import { expect, test } from '@playwright/test'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_DIFF_SHARE, pixelDiff, shoot, VIEW_POSES } from './shots.ts'

// Spec 4b §6: at the default view distance the branch draws main's picture. Two steps, each against whatever bundle the
// server on E2E_PORT serves (start `vite preview --outDir <bundle>` there first):
//   SHOTS_OUT=<dir>                   shoots the view bench's 4 poses in both 1024² scenes, frozen, into <dir>, with each
//                                     shot's console errors (main still logs three's "normal" warning: not asserted here);
//   COMPARE_A=<dir> COMPARE_B=<dir>   diffs each pair, writes the masks and compare.json into COMPARE_B, fails above
//                                     MAX_DIFF_SHARE or on any error in B.
const SCENES = ['world', 'terrain']
const SIZE = 1024
const SHOTS_OUT = process.env.SHOTS_OUT
const COMPARE_A = process.env.COMPARE_A, COMPARE_B = process.env.COMPARE_B

test.describe('shoot the view poses', () => {
  test.skip(!SHOTS_OUT, 'set SHOTS_OUT=<dir> to shoot the view poses')
  for (const scene of SCENES) {
    test(`${scene}`, async ({ page }) => {
      test.setTimeout(1_200_000)
      await page.setViewportSize({ width: 1280, height: 720 })
      mkdirSync(SHOTS_OUT!, { recursive: true })
      for (const [name, p] of Object.entries(VIEW_POSES)) {
        const shot = await shoot(page, `/?scene=${scene}&size=${SIZE}&still`, { t: [p.at[0] * SIZE, 40, p.at[1] * SIZE], d: p.distance, p: p.pitch, y: p.yaw })
        writeFileSync(join(SHOTS_OUT!, `${scene}-${name}.png`), shot.png)
        writeFileSync(join(SHOTS_OUT!, `${scene}-${name}.json`), JSON.stringify({ camera: shot.camera, backend: shot.backend, errors: shot.errors }))
      }
    })
  }
})

test.describe('compare two sets of shots', () => {
  test.skip(!COMPARE_A || !COMPARE_B, 'set COMPARE_A and COMPARE_B to two SHOTS_OUT dirs')
  test('every pose draws the same picture', async ({ page }) => {
    test.setTimeout(300_000)
    const shots = readdirSync(COMPARE_A!).filter(f => f.endsWith('.png') && !f.startsWith('diff-')).sort()
    const rows: { shot: string; share: number; differing: number; sameCamera: boolean; errorsA: number; errorsB: string[] }[] = []
    for (const f of shots) {
      const diff = await pixelDiff(page, readFileSync(join(COMPARE_A!, f)), readFileSync(join(COMPARE_B!, f)))
      writeFileSync(join(COMPARE_B!, `diff-${f}`), Buffer.from(diff.mask, 'base64'))
      const meta = (dir: string) => JSON.parse(readFileSync(join(dir, f.replace(/\.png$/, '.json')), 'utf8')) as { camera: number[]; errors: string[] }
      const a = meta(COMPARE_A!), b = meta(COMPARE_B!)
      const sameCamera = JSON.stringify(a.camera) === JSON.stringify(b.camera)
      rows.push({ shot: f.replace(/\.png$/, ''), share: diff.share, differing: diff.differing, sameCamera, errorsA: a.errors.length, errorsB: b.errors })
      console.log(`${f}: ${(diff.share * 100).toFixed(4)}% (${diff.differing} / ${diff.pixels})${sameCamera ? '' : ', camera differs'}; errors A ${a.errors.length}, B ${b.errors.length}`)
    }
    writeFileSync(join(COMPARE_B!, 'compare.json'), JSON.stringify({ a: COMPARE_A, b: COMPARE_B, maxShare: MAX_DIFF_SHARE, rows }, null, 2))
    expect(rows.length).toBe(SCENES.length * Object.keys(VIEW_POSES).length)
    for (const r of rows) {
      expect(r.sameCamera, r.shot).toBe(true)
      expect(r.share, r.shot).toBeLessThan(MAX_DIFF_SHARE)
      expect(r.errorsB, r.shot).toEqual([])
    }
  })
})
