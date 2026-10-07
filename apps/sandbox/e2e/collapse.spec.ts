import { expect, test } from '@playwright/test'
import type { Engine } from '@elovox/engine'

type W = Window & { __elovox?: { engine: Engine; collapse: { cutLeft(): void; cutRight(): void; cutTower(): void; cutNormal(): void }; ready: boolean } }
test('opt-in deck drops as a spanning fragment; normal beam stays put; tower keeps its cells', async ({ page }, info) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto('/?scene=collapse')
  await page.waitForFunction(() => (window as W).__elovox?.ready, null, { timeout: 120_000 })
  await page.waitForFunction(() => { const s = (window as W).__elovox!.engine.stats(); return !s.physicsBusy && s.meshQueue === 0 && s.meshInFlight === 0 })
  await page.locator('button', { hasText: 'Cut left support' }).click()
  await page.waitForFunction(() => (window as W).__elovox!.engine.world.get(24, 19, 28) === 0)
  expect(await page.evaluate(() => { const e = (window as W).__elovox!.engine; return e.world.get(32, 20, 29) === e.blocks.id('structural_planks') })).toBe(true)
  await page.locator('button', { hasText: 'Cut right support' }).click()
  await page.waitForFunction(() => (window as W).__elovox!.engine.stats().collapseFragments > 0)
  await page.waitForFunction(() => { const g = (window as W).__elovox!.engine.scene.getObjectByName('elovox-fragments'); return g?.children.some(b => b.position.y < -1) })
  await page.evaluate(() => (window as W).__elovox!.engine.physics.setPaused(true))
  await page.waitForFunction(() => { const e = (window as W).__elovox!.engine; return (e.scene.getObjectByName('elovox-fragments')?.children.length ?? 0) > 0 && e.stats().meshInFlight === 0 && e.stats().meshQueue === 0 })
  const rendered = await page.evaluate(() => {
    const e = (window as W).__elovox!.engine, g = e.scene.getObjectByName('elovox-fragments')!
    const mesh = g.children[0]?.children[0] as unknown as { geometry: { index: { count: number }; attributes: { position: { count: number } } } }
    return { fragments: g.children.length, indices: mesh.geometry.index.count, vertices: mesh.geometry.attributes.position.count }
  })
  expect(rendered.fragments).toBe(1)
  expect(rendered.indices).toBeLessThan(68 * 36)
  await page.locator('canvas').screenshot({ path: info.outputPath('connected-deck.png') })
  await page.evaluate(() => (window as W).__elovox!.engine.physics.setPaused(false))
  await page.waitForFunction(() => !((window as W).__elovox!.engine.stats().physicsBusy))
  await page.locator('button', { hasText: 'Cut normal beam' }).click()
  await page.locator('button', { hasText: 'Collapse tower' }).click()
  await page.waitForFunction(() => { const e = (window as W).__elovox!.engine; return e.world.get(72, 4, 28) === e.blocks.id('structural_planks') && !e.stats().physicsBusy })
  const final = await page.evaluate(() => {
    const e = (window as W).__elovox!.engine; let n = 0
    for (let y = 0; y < 64; y++) for (let z = 28; z <= 35; z++) for (let x = 72; x <= 79; x++) if (e.blocks.collapses[e.world.get(x, y, z) & 0xfff]) n++
    return { towerCells: n, normal: e.world.get(32, 20, 66), stone: e.blocks.id('stone') }
  })
  expect(final.towerCells).toBe(28 * 27)
  expect(final.normal).toBe(final.stone)
  await page.waitForFunction(() => { const e = (window as W).__elovox!.engine; return e.stats().meshQueue === 0 && e.stats().meshInFlight === 0 && !e.scene.getObjectByName('elovox-fragments')?.children.length })
  await page.locator('canvas').screenshot({ path: info.outputPath('landed-structures.png') })
  expect(errors).toEqual([])
})

test('WebGL2 renders a connected opaque/glass fragment and hands both cells back to the grid', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto('/?scene=collapse&webgl')
  await page.waitForFunction(() => (window as W).__elovox?.ready, null, { timeout: 120_000 })
  await page.waitForFunction(() => !((window as W).__elovox!.engine.stats().physicsBusy))
  expect(await page.evaluate(() => (window as W).__elovox!.engine.stats().backend)).toBe('webgl')
  await page.evaluate(() => {
    const e = (window as W).__elovox!.engine
    e.submit({ type: 'setBlock', pos: [6, 14, 110], voxel: e.blocks.id('structural_planks') })
    e.submit({ type: 'setBlock', pos: [7, 14, 110], voxel: e.blocks.id('structural_glass') })
  })
  await page.waitForFunction(() => (window as W).__elovox!.engine.scene.getObjectByName('elovox-fragments')?.children.some(b => b.children.length === 2))
  await page.waitForFunction(() => {
    const e = (window as W).__elovox!.engine
    return e.world.get(6, 4, 110) === e.blocks.id('structural_planks') && e.world.get(7, 4, 110) === e.blocks.id('structural_glass') && !e.stats().physicsBusy
  })
  expect(errors).toEqual([])
})
