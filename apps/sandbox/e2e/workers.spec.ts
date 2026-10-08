import { expect, test } from '@playwright/test'

test('a worker follows a continuous diagonal and turns toward its actual movement', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto('/?scene=workers&webgl')
  await page.waitForFunction(() => (window as any).__elovox?.ready && (window as any).__elovox.engine.workers?.stats.units === 8)
  await page.evaluate(() => {
    const e = (window as any).__elovox.engine
    ;(window as any).__motionTrace = []
    e.on('workers', (tick: any) => {
      const p = tick.poses, i = Array.from(p).findIndex((_: unknown, i: number) => i % 9 === 0 && p[i] === 1)
      if (i >= 0) (window as any).__motionTrace.push({ x: p[i + 1], z: p[i + 3], state: p[i + 5] })
    })
    e.submit({ type: 'unitDespawn', ids: [2, 3, 4, 5, 6, 7, 8] })
    e.submit({ type: 'unitMove', ids: [1], pos: [20, 5, 33] })
    for (const s of [e.controls.current, e.controls.goal]) { s.target = [17, 5, 31]; s.distance = 24; s.pitch = 1; s.yaw = .7 }
    e.controls.apply(e.camera)
  })
  await page.waitForFunction(() => {
    const a = (window as any).__motionTrace
    return a.some((p: any) => p.state === 2) && a.at(-1)?.state === 0
  })
  const result = await page.evaluate(() => {
    const a = (window as any).__motionTrace as { x: number; z: number; state: number }[]
    let distance = 0, stoppedTicks = 0, diagonalTicks = 0
    for (let i = 1; i < a.length; i++) {
      const dx = a[i]!.x - a[i - 1]!.x, dz = a[i]!.z - a[i - 1]!.z
      distance += Math.hypot(dx, dz) / 256
      if (dx && dz) diagonalTicks++
      if (a[i]!.state === 2 && a[i - 1]!.state === 2 && !dx && !dz) stoppedTicks++
    }
    return { distance, stoppedTicks, diagonalTicks, last: a.at(-1) }
  })
  expect(result.distance).toBeCloseTo(10, 1)
  expect(result.stoppedTicks).toBe(0)
  expect(result.diagonalTicks).toBeGreaterThan(30)
  expect(result.last).toMatchObject({ x: 20 * 256 + 128, z: 33 * 256 + 128, state: 0 })
  await expect.poll(() => page.evaluate(() => {
    let yaw = 0
    ;(window as any).__elovox.engine.scene.traverse((o: any) => { if (o.userData.unit === 1 && o.parent?.userData.unit !== 1) yaw = o.rotation.y })
    return Math.abs(yaw - Math.atan2(8, 6))
  })).toBeLessThan(.02)
  expect(errors).toEqual([])
  await page.screenshot({ path: 'test-results/workers-smooth-diagonal.png' })
})

test('units open a tunnel and construct a bridge and wall with real inventory', async ({ page }) => {
  test.setTimeout(180000)
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message))
  await page.goto('/?scene=workers&webgl')
  await page.waitForFunction(() => (window as any).__elovox?.ready)
  await page.waitForFunction(() => (window as any).__elovox.engine.workers?.stats.units === 8)
  await expect(page.getByRole('heading', { name: 'Unidades & obras' })).toBeVisible()
  await page.evaluate(() => {
    const e = (window as any).__elovox.engine, stock = new Map<number, { block: number; count: number }[]>()
    ;(window as any).__workerStock = stock
    e.on('workers', (tick: any) => { for (const u of tick.details) stock.set(u.id, u.stock) })
    // Request fresh detail deltas without adding inventory.
    e.submit({ type: 'unitStock', ids: Array.from({ length: 8 }, (_, i) => i + 1), block: e.blocks.id('planks'), count: 0 })
  })
  await page.waitForFunction(() => (window as any).__workerStock.size === 8)
  const plankStock = () => page.evaluate(() => {
    const w = window as any, block = w.__elovox.engine.blocks.id('planks')
    return [...w.__workerStock.values()].reduce((n: number, items: any) => n + items.reduce((total: number, q: any) => total + (q.block === block ? q.count : 0), 0), 0) as number
  })
  const initialPlanks = await plankStock()
  await page.getByRole('button', { name: 'Abrir túnel' }).click()
  await page.waitForFunction(() => {
    const w = (window as any).__elovox.engine.world
    for (let y = 5; y <= 6; y++) for (let x = 22; x <= 26; x++) if (w.get(x, y, 29) !== 0) return false
    return true
  }, null, { timeout: 60000 })
  expect(await plankStock()).toBe(initialPlanks)
  await page.getByRole('button', { name: 'Montar ponte' }).click()
  await page.waitForFunction(() => {
    const e = (window as any).__elovox.engine
    return [42, 43, 44, 45, 46].every(x => e.world.get(x, 4, 30) === e.blocks.id('planks'))
  }, null, { timeout: 60000 })
  await expect.poll(plankStock).toBe(initialPlanks - 5)
  await page.getByRole('button', { name: 'Erguer parede' }).click()
  await page.waitForFunction(() => {
    const e = (window as any).__elovox.engine
    for (let y = 5; y <= 6; y++) for (let x = 32; x <= 36; x++) if (e.world.get(x, y, 28) !== e.blocks.id('planks')) return false
    return true
  }, null, { timeout: 60000 })
  await expect.poll(plankStock).toBe(initialPlanks - 15)
  const result = await page.evaluate(() => {
    const e = (window as any).__elovox.engine
    return { units: e.workers.stats.units, orders: e.workers.orders.map((o: any) => ({ total: o.total, done: o.done })), stats: e.stats() }
  })
  expect(result.units).toBe(8); expect(result.orders.every((o: any) => o.done === o.total)).toBe(true)
  expect(errors).toEqual([])
  await expect(page.locator('.workers-status')).toContainText('Construção #3 · 10/10')
  await page.waitForFunction(() => { const s = (window as any).__elovox.engine.stats(); return s.meshQueue === 0 && s.meshInFlight === 0 })
  await page.screenshot({ path: 'test-results/workers-complete.png' })
})

test('a camera drag allows later unit selection and manual dig designation', async ({ page }) => {
  await page.goto('/?scene=workers&webgl')
  await page.waitForFunction(() => (window as any).__elovox?.ready && (window as any).__elovox.engine.workers?.stats.units === 8)
  await page.evaluate(() => {
    const e = (window as any).__elovox.engine
    for (const s of [e.controls.current, e.controls.goal]) { s.target = [15, 5, 28]; s.distance = 30; s.pitch = 1; s.yaw = .7 }
    e.controls.apply(e.camera)
  })
  const point = (pos: [number, number, number]) => page.evaluate(pos => {
    const e = (window as any).__elovox.engine, canvas = document.querySelector('canvas')!, rect = canvas.getBoundingClientRect()
    const p = e.camera.position.clone().set(...pos).project(e.camera)
    return { x: rect.left + (p.x + 1) * rect.width / 2, y: rect.top + (1 - p.y) * rect.height / 2 }
  }, pos)
  const start = await point([12.5, 5.8, 27.5])
  await page.mouse.move(start.x, start.y); await page.mouse.down({ button: 'right' })
  await page.mouse.move(start.x + 50, start.y, { steps: 5 }); await page.mouse.up({ button: 'right' })
  await page.waitForFunction(() => {
    const c = (window as any).__elovox.engine.controls
    return c.lastDragDistance >= 6 && Math.abs(c.current.yaw - c.goal.yaw) < .001
  })
  const unit = await point([12.5, 5.8, 27.5])
  await page.mouse.click(unit.x, unit.y)
  await expect(page.locator('.workers-status')).toContainText('#1 Livre')
  await page.getByRole('button', { name: 'Escavar', exact: true }).click()
  const ground = await point([18.5, 5, 25.5])
  const target = await page.evaluate(({ x, y }) => (window as any).__elovox.engine.pickScreen(x, y)?.pos, ground)
  expect(target).toBeDefined()
  await page.mouse.move(ground.x, ground.y); await page.mouse.down()
  await page.mouse.move(ground.x + 20, ground.y, { steps: 3 }); await page.mouse.up()
  // A wrongly submitted order would only show up after the sim has processed it, so wait for two published ticks.
  await page.evaluate(() => new Promise<void>(resolve => {
    let ticks = 0; const off = (window as any).__elovox.engine.on('workers', () => { if (++ticks === 2) { off(); resolve() } })
  }))
  expect(await page.evaluate(() => (window as any).__elovox.engine.workers.orders.length)).toBe(0)
  // Paused, so a nearby unit cannot finish the one-cell dig before it is cancelled; commands still apply.
  await page.getByRole('button', { name: 'Pausar', exact: true }).click()
  expect(await page.evaluate(() => (window as any).__elovox.engine.physics.paused)).toBe(true)
  await page.mouse.click(ground.x, ground.y)
  await page.waitForFunction(target => {
    const o = (window as any).__elovox.engine.workers.orders[0]
    return o?.kind === 'dig' && o.min.every((v: number, i: number) => v === target[i]) && o.total === 1
  }, target)
  await page.getByRole('button', { name: 'Cancelar obras', exact: true }).click()
  await page.waitForFunction(() => (window as any).__elovox.engine.workers.orders[0].cancelled)
  await page.getByRole('button', { name: 'Retomar', exact: true }).click()
  expect(await page.evaluate(() => (window as any).__elovox.engine.physics.paused)).toBe(false)
})
