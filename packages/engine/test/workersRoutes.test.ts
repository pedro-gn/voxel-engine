import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import type { Command } from '../src/sim/commands.ts'
import type { WorkerOptions } from '../src/sim/workers/types.ts'
import type { GeneratorContext } from '../src/sim/generator.ts'
import { PathSearch } from '../src/sim/navigation/navigation.ts'
import { GroupField } from '../src/sim/navigation/groupField.ts'
import { RouteSearch } from '../src/sim/navigation/routeSearch.ts'

const blocks = [{ name: 'stone' }, { name: 'planks' }, { name: 'water', liquid: true }, { name: 'sand', falls: true }, { name: 'beam', collapses: true }]
/** A side × 32 × side floor at y = 4, with the navigation budget of the scale target. */
function makeWide(side: number, extra?: (ctx: GeneratorContext, cx: number, cz: number) => void, options: WorkerOptions = {}) {
  const sim = new Simulation({ buffers: createWorldBuffers([side, 32, side]), blocks, seed: 1, randomTicksPerChunk: 0, workers: { searchCap: 32768, materials: { stone: { digTicks: 4, buildTicks: 3 }, planks: { digTicks: 2, buildTicks: 3 } }, ...options } })
  sim.generate({ generateColumn(ctx, cx, cz) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) ctx.set(x, y, z, 1); extra?.(ctx, cx, cz) } })
  return sim
}
let seq = 0
function cmd(sim: Simulation, command: Command) { sim.submit(0, ++seq, command); const r = sim.step(); expect(r.acks[0]?.ok, r.acks[0]?.error).toBe(true); return r }
function spawn(sim: Simulation, pos = [5, 4, 5], stock: { block: number; count: number }[] = []) { cmd(sim, { type: 'unitSpawn', pos, stock }); return sim.workers!.units.size }
function until(sim: Simulation, predicate: () => boolean, cap = 500) { for (let i = 0; i < cap; i++) { if (predicate()) return; sim.step() }; expect(predicate(), JSON.stringify(sim.workers!.publication().stats)).toBe(true) }

describe('hierarchical routes', { timeout: 60_000 }, () => {
  it('walks a 200-block move through route segments and arrives', () => {
    const sim = makeWide(256); spawn(sim, [5, 4, 5])
    cmd(sim, { type: 'unitMove', ids: [1], pos: [220, 4, 200] })
    expect(sim.workers!.units.get(1)!.route?.search).toBeInstanceOf(RouteSearch)
    until(sim, () => sim.workers!.view(1)?.state === 'walking', 40) // first action within 2 s
    let peak = 0
    for (let i = 0; i < 4000 && sim.workers!.view(1)?.state !== 'idle'; i++) { const r = sim.step(); peak = Math.max(peak, r.workers!.stats.visited); expect(r.workers!.stats.visited).toBeLessThanOrEqual(32768) }
    expect(sim.workers!.view(1)).toMatchObject({ state: 'idle', x256: 220 * 256 + 128, z256: 200 * 256 + 128 })
    expect(sim.workers!.units.get(1)!.route).toBeNull()
    expect(peak).toBeGreaterThan(0)
  })
  it('a wall built across the next segment makes the unit stop safely, replan and still arrive', () => {
    const sim = makeWide(256); spawn(sim, [5, 4, 5])
    cmd(sim, { type: 'unitMove', ids: [1], pos: [220, 4, 5] })
    until(sim, () => (sim.workers!.view(1)?.x256 ?? 0) > 60 * 256, 2000)
    cmd(sim, { type: 'fillRegion', min: [100, 4, 0], max: [100, 7, 30], voxel: 1 })
    for (let i = 0; i < 6000 && sim.workers!.view(1)?.state !== 'idle'; i++) {
      sim.step()
      const v = sim.workers!.view(1)!, x = v.x256 >> 8, z = v.z256 >> 8
      // Never inside the new wall.
      expect(x === 100 && z <= 30 && v.y256 < 8 * 256).toBe(false)
    }
    expect(sim.workers!.view(1)).toMatchObject({ state: 'idle', x256: 220 * 256 + 128, z256: 5 * 256 + 128 })
  })
  it('replacing the world under a unit holding a settled route drops the route and replans on the new world', () => {
    const sim = makeWide(128); spawn(sim, [5, 4, 5])
    cmd(sim, { type: 'unitMove', ids: [1], pos: [120, 4, 5] })
    const u = sim.workers!.units.get(1)!
    until(sim, () => u.route !== null && u.route.last >= 0 && u.route.search.status === 'found' && u.state === 'walking', 200)
    const old = u.route!.search
    // The new world has a wall across the old route with a gap at z > 30.
    sim.generate({ generateColumn(ctx, cx, cz) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) { for (let y = 0; y < 4; y++) ctx.set(x, y, z, 1); if (cx * 32 + x === 60 && cz * 32 + z <= 30) for (let y = 4; y < 8; y++) ctx.set(x, y, z, 1) } } })
    expect(u.route).toBeNull(); expect(u.segment).toBeNull(); expect(u.path.length).toBeLessThanOrEqual(u.cursor)
    expect(old.status).toBe('found'); expect(sim.workers!.nav.regions.size).toBe(0)
    let replanned = false
    for (let i = 0; i < 3000 && u.state !== 'idle'; i++) {
      sim.step()
      if (u.route && u.route.search !== old) replanned = true
      expect((u.x >> 8) === 60 && (u.z >> 8) <= 30 && u.y < 8 * 256).toBe(false)
    }
    expect(replanned).toBe(true)
    expect(sim.workers!.view(1)).toMatchObject({ state: 'idle', x256: 120 * 256 + 128, z256: 5 * 256 + 128 })
  })
  it('escape from a build designation stays on the flat search', () => {
    // Spawn inside a build box, then order a long move: the first query must be a PathSearch with an allowed override.
    const sim = makeWide(256); spawn(sim, [10, 4, 10])
    cmd(sim, { type: 'workBuild', min: [8, 4, 8], max: [12, 4, 12], voxel: 2 })
    cmd(sim, { type: 'unitMove', ids: [1], pos: [200, 4, 200] })
    const u = sim.workers!.units.get(1)!
    expect(u.route).toBeNull(); expect(u.search).toBeInstanceOf(PathSearch); expect(u.escape.length).toBe(1)
  })
  it('a unit standing on sand plans its long walk on the flat search', () => {
    const sim = makeWide(256); spawn(sim, [10, 4, 10])
    cmd(sim, { type: 'fillRegion', min: [10, 3, 10], max: [10, 3, 10], voxel: 4 })
    cmd(sim, { type: 'unitMove', ids: [1], pos: [200, 4, 200] })
    const u = sim.workers!.units.get(1)!
    expect(u.route).toBeNull(); expect(u.search).toBeInstanceOf(PathSearch)
  })
  it('a group move resolves every unit from one group field and every unit arrives', () => {
    const sim = makeWide(256)
    for (let i = 0; i < 20; i++) spawn(sim, [4 + (i % 5) * 2, 4, 4 + Math.floor(i / 5) * 2])
    cmd(sim, { type: 'unitMove', ids: [...sim.workers!.units.keys()], pos: [200, 4, 200] })
    const fields = new Set([...sim.workers!.units.values()].map(u => u.route?.search))
    expect(fields.size).toBe(1); expect([...fields][0]).toBeInstanceOf(GroupField)
    until(sim, () => [...sim.workers!.units.values()].every(u => u.state === 'walking' || u.state === 'idle'), 60)
    // Every unit arrives (the unitArrived event); arrived units may later make way for others, up to 16 blocks.
    const arrived = new Set<number>()
    for (let i = 0; i < 6000 && ![...sim.workers!.units.values()].every(u => u.state === 'idle'); i++) for (const e of sim.step().events) if (e.type === 'unitArrived') arrived.add((e.payload as { id: number }).id)
    expect(arrived.size).toBe(20)
    const goals = new Set([...sim.workers!.units.values()].map(u => `${u.x >> 8},${u.z >> 8}`))
    expect(goals.size).toBe(20)
    for (const u of sim.workers!.units.values()) { expect(Math.abs((u.x >> 8) - 200)).toBeLessThanOrEqual(6 + 16); expect(Math.abs((u.z >> 8) - 200)).toBeLessThanOrEqual(6 + 16) }
  })
  it('a group whose straight way crosses head-deep water walks around it and every unit arrives', () => {
    // A basin across x = 100..103, z = 0..27 (from the world's edge), two deep in the middle (x = 101..102) and one deep at its rims, full of
    // water to the floor's top: crossing it means a pose with water in the head cell. Dry, it would be crossable
    // (drop 1, drop 1, climb 1, climb 1). The way around is at z >= 28.
    const sim = makeWide(256, (ctx, cx, cz) => {
      for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
        const wx = cx * 32 + x, wz = cz * 32 + z
        if (wx < 100 || wx > 103 || wz > 27) continue
        const water = 3 | (7 << 12)
        ctx.set(x, 3, z, water)
        if (wx === 101 || wx === 102) ctx.set(x, 2, z, water)
      }
    })
    for (let i = 0; i < 10; i++) spawn(sim, [60 + (i % 5) * 2, 4, 6 + Math.floor(i / 5) * 2])
    cmd(sim, { type: 'unitMove', ids: [...sim.workers!.units.keys()], pos: [160, 4, 10] })
    for (let i = 0; i < 4000 && [...sim.workers!.units.values()].some(u => u.state !== 'idle'); i++) {
      sim.step()
      for (const u of sim.workers!.units.values()) expect(sim.registry.liquid[sim.store.getVoxel(u.x >> 8, (u.y >> 8) + 1, u.z >> 8) & 0xfff], `unit ${u.id} head under water`).toBe(0)
    }
    expect([...sim.workers!.units.values()].map(u => u.state)).toEqual(Array(10).fill('idle'))
    for (const u of sim.workers!.units.values()) expect(Math.abs((u.x >> 8) - 160)).toBeLessThanOrEqual(10) // formation spiral (spacing 2) plus retargeting
  })
  it('water that floods a basin across a route already planned is walked around', () => {
    const sim = makeWide(256)
    // The same basin as above, dug dry: x = 100 and 103 one deep, x = 101..102 two deep, z = 0..27.
    cmd(sim, { type: 'fillRegion', min: [100, 3, 0], max: [103, 3, 27], voxel: 0 }); cmd(sim, { type: 'fillRegion', min: [101, 2, 0], max: [102, 2, 27], voxel: 0 })
    for (let i = 0; i < 10; i++) spawn(sim, [60 + (i % 5) * 2, 4, 6 + Math.floor(i / 5) * 2])
    cmd(sim, { type: 'unitMove', ids: [...sim.workers!.units.keys()], pos: [160, 4, 10] })
    // The dry basin is on the way: let everyone set off, then flood it before anyone reaches it.
    until(sim, () => [...sim.workers!.units.values()].every(u => u.state === 'walking' || (u.x >> 8) > 70), 400)
    expect([...sim.workers!.units.values()].every(u => (u.x >> 8) < 95)).toBe(true)
    const water = 3 | (7 << 12)
    cmd(sim, { type: 'fillRegion', min: [100, 3, 0], max: [103, 3, 27], voxel: water }); cmd(sim, { type: 'fillRegion', min: [101, 2, 0], max: [102, 2, 27], voxel: water })
    for (let i = 0; i < 4000 && [...sim.workers!.units.values()].some(u => u.state !== 'idle'); i++) {
      sim.step()
      for (const u of sim.workers!.units.values()) expect(sim.registry.liquid[sim.store.getVoxel(u.x >> 8, (u.y >> 8) + 1, u.z >> 8) & 0xfff], `unit ${u.id} head under water`).toBe(0)
    }
    expect([...sim.workers!.units.values()].map(u => u.state)).toEqual(Array(10).fill('idle'))
    for (const u of sim.workers!.units.values()) expect(Math.abs((u.x >> 8) - 160)).toBeLessThanOrEqual(10) // formation spiral (spacing 2) plus retargeting
  })
  it('a unit caught by water rising over its head wades out to dry ground and carries on to its goal', () => {
    const sim = makeWide(256)
    // A basin dug dry, two deep and four wide in the middle (x = 101..104), one deep at its rims (x = 100, 105). The unit
    // stands on the deep floor (y = 2) when the water comes: every pose next to it then has water in the head cell.
    cmd(sim, { type: 'fillRegion', min: [100, 3, 0], max: [105, 3, 27], voxel: 0 }); cmd(sim, { type: 'fillRegion', min: [101, 2, 0], max: [104, 2, 27], voxel: 0 })
    spawn(sim, [102, 2, 10]); spawn(sim, [103, 2, 12])
    // Ordered while dry, the two share a group route; the water comes in the next tick, before they are out.
    cmd(sim, { type: 'unitMove', ids: [1, 2], pos: [160, 4, 10] })
    expect([...sim.workers!.units.values()].every(u => u.route !== null)).toBe(true)
    const water = 3 | (7 << 12)
    sim.submit(0, ++seq, { type: 'fillRegion', min: [100, 3, 0], max: [105, 3, 27], voxel: water }); sim.submit(0, ++seq, { type: 'fillRegion', min: [101, 2, 0], max: [104, 2, 27], voxel: water })
    sim.step()
    const units = [...sim.workers!.units.values()]
    expect(units.every(u => sim.registry.liquid[sim.store.getVoxel(u.x >> 8, (u.y >> 8) + 1, u.z >> 8) & 0xfff] === 1)).toBe(true) // heads under water
    until(sim, () => units.every(u => u.state === 'idle' && u.goal === null), 4000)
    for (const u of units) expect(Math.abs((u.x >> 8) - 160) + Math.abs((u.z >> 8) - 10)).toBeLessThanOrEqual(4)
  })
  it('a group of 40 packed units starts walking within 5 ticks of a far move order on a warm world', () => {
    const sim = makeWide(256, undefined, { searchCap: 8192 })
    for (let i = 0; i < 40; i++) spawn(sim, [4 + (i % 8) * 2, 4, 4 + Math.floor(i / 8) * 2])
    // Warm: let the prebuild build every tile first, as the bench does.
    for (let i = 0; i < 4000 && !sim.workers!.nav.prebuildStatus().done; i++) sim.step()
    cmd(sim, { type: 'unitMove', ids: [...sim.workers!.units.keys()], pos: [200, 4, 200] })
    const started = new Map<number, number>()
    for (let t = 1; t <= 60; t++) { sim.step(); for (const u of sim.workers!.units.values()) if (u.state === 'walking' && !started.has(u.id)) started.set(u.id, t) }
    const ticks = [...started.values()].sort((a, b) => a - b)
    expect(ticks.length).toBe(40)
    expect(ticks[Math.floor(ticks.length * 0.95)]).toBeLessThanOrEqual(5)
  })
  it('while a unit with nothing to walk waits for its route, repairs get at most an eighth of the budget', () => {
    // A head-on jam in a two-wide corridor (repairs) next to a far unit planning a long cold route (a pending search).
    const sim = makeWide(256, (ctx, cx, cz) => {
      if (cx || cz) return
      for (let x = 2; x <= 29; x++) for (let y = 4; y < 6; y++) { ctx.set(x, y, 4, 1); ctx.set(x, y, 7, 1) }
      for (let y = 4; y < 6; y++) for (const z of [5, 6]) { ctx.set(2, y, z, 1); ctx.set(29, y, z, 1) }
    }, { searchCap: 1024, sleep: false })
    for (let x = 3; x <= 12; x++) spawn(sim, [x, 4, 5])
    for (let x = 19; x <= 28; x++) spawn(sim, [x, 4, 5])
    const far = spawn(sim, [120, 4, 120])
    let id = 0
    for (let x = 3; x <= 12; x++) sim.submit(0, ++seq, { type: 'unitMove', ids: [++id], pos: [x + 16, 4, 6] })
    for (let x = 19; x <= 28; x++) sim.submit(0, ++seq, { type: 'unitMove', ids: [++id], pos: [x - 16, 4, 6] })
    sim.step()
    const w = sim.workers as unknown as { engineeringVisited: number; refineWork: number }, u = sim.workers!.units.get(far)!
    let starvedTicks = 0, peak = 0
    for (let t = 0; t < 300; t++) {
      if (t === 20) cmd(sim, { type: 'unitMove', ids: [far], pos: [250, 4, 250] })
      sim.step()
      const pending = u.path[u.cursor] === undefined && !u.motion && u.route?.search.status === 'pending'
      if (pending) { starvedTicks++; peak = Math.max(peak, w.engineeringVisited) }
    }
    expect(starvedTicks).toBeGreaterThan(0)
    expect(peak).toBeLessThanOrEqual(1024 >> 3)
  })
  it('a far work task walks a route, claims only its final pose and gets done', () => {
    const sim = makeWide(256); spawn(sim, [5, 4, 5])
    cmd(sim, { type: 'workDig', min: [200, 3, 200], max: [200, 3, 200] })
    until(sim, () => sim.workers!.units.get(1)!.route !== null, 5)
    until(sim, () => sim.workers!.units.get(1)!.route?.last !== -1, 200)
    expect(sim.workers!.units.get(1)!.workPoses).toHaveLength(1)
    until(sim, () => sim.workers!.publication().orders[0]?.done === 1, 4000)
  })
  it('replays route and group commands with the same hashes', () => {
    const run = () => {
      const sim = makeWide(128), hashes: number[] = []
      for (let i = 0; i < 4; i++) spawn(sim, [4 + i * 2, 4, 4])
      cmd(sim, { type: 'unitMove', ids: [1, 2, 3], pos: [110, 4, 100] })
      cmd(sim, { type: 'unitMove', ids: [4], pos: [100, 4, 120] })
      for (let t = 0; t < 120; t++) { sim.step(); hashes.push(sim.hash()) }
      cmd(sim, { type: 'fillRegion', min: [60, 4, 0], max: [60, 7, 90], voxel: 1 })
      for (let t = 0; t < 200; t++) { sim.step(); hashes.push(sim.hash()) }
      return hashes
    }
    expect(run()).toEqual(run())
  })
  /** Counts the route searches the workers start. */
  function countRoutes(sim: Simulation) {
    const nav = sim.workers!.nav, route = nav.route.bind(nav), count = { n: 0 }
    nav.route = (...args) => { count.n++; return route(...args) }
    return count
  }
  it('a long move to a walled-in destination blocks with no-access instead of replanning every tick', () => {
    const sim = makeWide(128); spawn(sim, [5, 4, 5])
    // A ring of stone two high around (100,4,100): the destination stands, but nothing reaches it.
    for (const [min, max] of [[[98, 4, 98], [102, 5, 98]], [[98, 4, 102], [102, 5, 102]], [[98, 4, 99], [98, 5, 101]], [[102, 4, 99], [102, 5, 101]]] as const) cmd(sim, { type: 'fillRegion', min: [...min], max: [...max], voxel: 1 })
    const routes = countRoutes(sim)
    cmd(sim, { type: 'unitMove', ids: [1], pos: [100, 4, 100] })
    expect(sim.workers!.units.get(1)!.route?.search).toBeInstanceOf(RouteSearch)
    until(sim, () => sim.workers!.view(1)?.state === 'blocked', 400)
    expect(sim.workers!.view(1)?.reason).toBe('no-access')
    // Spare operations prebuild the world and its landmark tables first; once all is built they rest too.
    until(sim, () => sim.workers!.nav.prebuilt && sim.workers!.nav.prebuildStatus().done, 3000)
    const before = routes.n
    let visited = 0
    for (let i = 0; i < 100; i++) visited += sim.step().workers!.stats.visited
    expect(routes.n - before).toBe(0); expect(visited).toBe(0); expect(sim.workers!.nav.pending).toBe(0)
  })
  it('a move from two far-apart clusters makes one group field per cluster', () => {
    const sim = makeWide(256)
    for (let i = 0; i < 4; i++) spawn(sim, [4 + i * 2, 4, 4])
    for (let i = 0; i < 4; i++) spawn(sim, [4 + i * 2, 4, 200])
    cmd(sim, { type: 'unitMove', ids: [...sim.workers!.units.keys()], pos: [220, 4, 100] })
    const units = [...sim.workers!.units.values()], fields = units.map(u => u.route?.search)
    expect(new Set(fields).size).toBe(2); expect(fields.every(f => f instanceof GroupField)).toBe(true)
    expect(fields[0]).toBe(fields[3]); expect(fields[4]).toBe(fields[7]); expect(fields[0]).not.toBe(fields[4])
    until(sim, () => units.every(u => u.goal === null), 4000)
  })
  it('a group field that ended limited still serves its units: none plans a route of its own', () => {
    const sim = makeWide(256)
    for (let i = 0; i < 6; i++) spawn(sim, [4 + i * 2, 4, 4])
    const routes = countRoutes(sim)
    cmd(sim, { type: 'unitMove', ids: [...sim.workers!.units.keys()], pos: [200, 4, 200] })
    const field = sim.workers!.units.get(1)!.route!.search as GroupField
    until(sim, () => field.status !== 'pending', 200)
    // As if its node cap cut it after settling every start.
    ;(field as unknown as { status: string }).status = 'limited'
    until(sim, () => [...sim.workers!.units.values()].every(u => u.goal === null), 4000)
    expect(routes.n).toBe(0)
  })
  it('spare operations prebuild the world, nearest the units first, within the budget, and a long move then starts warm', () => {
    const sim = makeWide(256, undefined, { searchCap: 4096 }); spawn(sim, [200, 4, 200])
    const nav = sim.workers!.nav, near = nav.tileOf(200, 4, 200)
    // The unit's own tile is built first; at prebuildCap operations per tick that takes a few ticks.
    until(sim, () => nav.regions.get(near) !== undefined, 10)
    for (let i = 0; i < 3000 && !nav.prebuilt; i++) expect(sim.step().workers!.stats.visited).toBeLessThanOrEqual(4096)
    expect(nav.prebuilt).toBe(true)
    expect(nav.regions.size).toBe(nav.revisions.length)
    // Warm: the route is found in its first slice, and the unit sets off at once.
    cmd(sim, { type: 'unitMove', ids: [1], pos: [10, 4, 10] })
    until(sim, () => sim.workers!.view(1)?.state === 'walking', 3)
  })
  it('a route that ends stale backs off instead of replanning the same tick', () => {
    const sim = makeWide(128); spawn(sim, [5, 4, 5])
    const routes = countRoutes(sim)
    cmd(sim, { type: 'unitMove', ids: [1], pos: [100, 4, 100] })
    const u = sim.workers!.units.get(1)!, search = u.route!.search as RouteSearch
    expect(routes.n).toBe(1)
    // As if a region it read changed under it.
    ;(search as unknown as { status: string }).status = 'stale'
    sim.step()
    const time = (sim.workers as unknown as { time: number }).time
    expect(u.route).toBeNull(); expect(routes.n).toBe(1); expect(u.retry).toBeGreaterThan(time)
    until(sim, () => routes.n === 2, 40)
  })
  /** Path nodes from the unit's pose on: each one is the previous one or a support neighbour of it. */
  function broken(sim: Simulation, u: { path: number[]; cursor: number }): string | null {
    const nav = sim.workers!.nav, L = sim.layout, path = u.path.slice(Math.max(0, u.cursor - 1))
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]!, b = path[i]!
      if (a !== b && ![0, 1, 2, 3].some(d => nav.neighbor(a, d) === b)) return `${L.voxelCoords(a)} -> ${L.voxelCoords(b)}`
    }
    return null
  }
  it('routed paths stay continuous through traffic: two groups crossing head-on never block with target-changed', () => {
    const sim = makeWide(192)
    for (let i = 0; i < 12; i++) spawn(sim, [8 + (i % 4) * 2, 4, 90 + Math.floor(i / 4) * 2])
    for (let i = 0; i < 12; i++) spawn(sim, [176 + (i % 4) * 2, 4, 90 + Math.floor(i / 4) * 2])
    const ids = [...sim.workers!.units.keys()]
    cmd(sim, { type: 'unitMove', ids: ids.slice(0, 12), pos: [178, 4, 92] })
    cmd(sim, { type: 'unitMove', ids: ids.slice(12), pos: [10, 4, 92] })
    const reasons = new Set<string>()
    for (let t = 0; t < 3000 && [...sim.workers!.units.values()].some(u => u.goal !== null); t++) {
      sim.step()
      for (const u of sim.workers!.units.values()) {
        if (u.reason) reasons.add(u.reason)
        if (u.route) expect(broken(sim, u), `unit ${u.id} tick ${t}`).toBeNull()
      }
    }
    expect(reasons.has('target-changed')).toBe(false)
    expect([...sim.workers!.units.values()].filter(u => u.goal !== null).map(u => u.id)).toEqual([])
  })
  it('units detoured off their group route by traffic carry on from the group field instead of planning routes of their own', () => {
    const sim = makeWide(192)
    for (let i = 0; i < 12; i++) spawn(sim, [8 + (i % 4) * 2, 4, 90 + Math.floor(i / 4) * 2])
    for (let i = 0; i < 12; i++) spawn(sim, [176 + (i % 4) * 2, 4, 90 + Math.floor(i / 4) * 2])
    const ids = [...sim.workers!.units.keys()], routes = countRoutes(sim)
    cmd(sim, { type: 'unitMove', ids: ids.slice(0, 12), pos: [178, 4, 92] })
    cmd(sim, { type: 'unitMove', ids: ids.slice(12), pos: [10, 4, 92] })
    until(sim, () => [...sim.workers!.units.values()].every(u => u.goal === null), 3000)
    expect(routes.n).toBe(0)
  })
  it('a routed unit moved off its path onto another level carries on from where it stands instead of blocking', () => {
    // A one-block ridge along z = 21 of every chunk, beside the straight line the route takes at z = 20.
    const sim = makeWide(256, ctx => { for (let x = 0; x < 32; x++) ctx.set(x, 4, 21, 1) }); spawn(sim, [10, 4, 20])
    const u = sim.workers!.units.get(1)!, L = sim.layout, routes = countRoutes(sim)
    cmd(sim, { type: 'unitMove', ids: [1], pos: [220, 4, 20] })
    until(sim, () => u.route?.search.status === 'found' && u.path[u.cursor] !== undefined && (u.x >> 8) > 40, 2000)
    // As if pushed off its step: on top of the ridge, off the path and one level up.
    u.motion = null; u.x = (u.x >> 8) * 256 + 128; u.y = 5 * 256; u.z = 21 * 256 + 128
    const reasons = new Set<string>()
    for (let i = 0; i < 3000 && u.goal !== null; i++) { sim.step(); if (u.reason) reasons.add(u.reason) }
    expect(reasons.has('target-changed')).toBe(false)
    expect(sim.workers!.view(1)).toMatchObject({ state: 'idle', x256: 220 * 256 + 128, z256: 20 * 256 + 128 })
    expect(routes.n).toBe(1)
  })
  it('edits in regions ahead of a walking group are recovered locally: no unit plans a route of its own, all arrive', () => {
    const sim = makeWide(256)
    for (let i = 0; i < 8; i++) spawn(sim, [4 + (i % 4) * 2, 4, 100 + Math.floor(i / 4) * 2])
    const routes = countRoutes(sim)
    cmd(sim, { type: 'unitMove', ids: [...sim.workers!.units.keys()], pos: [240, 4, 102] })
    until(sim, () => [...sim.workers!.units.values()].every(u => (u.x >> 8) > 40), 1500)
    const nav = sim.workers!.nav, before = [...nav.revisions]
    // Pillars in every region the group still has to cross: each region changes, none is cut.
    for (let x = 72; x < 240; x += 16) for (let z = 88; z < 120; z += 16) cmd(sim, { type: 'fillRegion', min: [x, 4, z], max: [x, 6, z], voxel: 1 })
    expect(nav.revisions.filter((r, i) => r !== before[i]).length).toBeGreaterThan(20)
    until(sim, () => [...sim.workers!.units.values()].every(u => u.goal === null), 4000)
    expect(routes.n).toBe(0)
    for (const u of sim.workers!.units.values()) expect(Math.abs((u.x >> 8) - 240)).toBeLessThanOrEqual(4)
  })
})
describe('traffic blocks on group routes', { timeout: 60_000 }, () => {
  it('a unit blocked on traffic keeps its group route and carries on from where it stands, without a route of its own', () => {
    const sim = makeWide(256)
    for (let i = 0; i < 8; i++) spawn(sim, [4 + (i % 4) * 2, 4, 100 + Math.floor(i / 4) * 2])
    const nav = sim.workers!.nav, route = nav.route.bind(nav), routes = { n: 0 }
    nav.route = (...args) => { routes.n++; return route(...args) }
    cmd(sim, { type: 'unitMove', ids: [...sim.workers!.units.keys()], pos: [240, 4, 102] })
    const w = sim.workers! as unknown as { units: Map<number, { route: { search: unknown } | null; goal: number | null; x: number }>; block(u: unknown, reason: string): void }
    const u = w.units.get(1)!
    until(sim, () => (u.x >> 8) > 40, 1500)
    const field = u.route!.search
    expect(field).toBeInstanceOf(GroupField)
    w.block(u, 'traffic')
    expect(u.route?.search).toBe(field)
    until(sim, () => [...w.units.values()].every(v => v.goal === null), 4000)
    expect(routes.n).toBe(0)
  })
})
describe('background navigation work', { timeout: 60_000 }, () => {
  it('a cold world warms on the whole leftover budget; once warm, the prebuild never spends more than prebuildCap in a tick', () => {
    const sim = makeWide(256, undefined, { prebuildCap: 256 }); spawn(sim, [5, 4, 5])
    // 512 tiles with landmark tables: far more than 256 operations a tick for a few hundred ticks would allow.
    until(sim, () => sim.workers!.nav.prebuildStatus().done, 600)
    for (let i = 0; i < 100; i++) expect(sim.step().workers!.stats.visited).toBeLessThanOrEqual(256)
    cmd(sim, { type: 'fillRegion', min: [40, 4, 40], max: [200, 4, 200], voxel: 3 | (7 << 12) })
    for (let i = 0; i < 200; i++) expect(sim.step().workers!.stats.visited).toBeLessThanOrEqual(256)
  })
  it('with no units and no queries, the navigation does no background work', () => {
    const sim = makeWide(128)
    for (let i = 0; i < 50; i++) expect(sim.step().workers!.stats.visited).toBe(0)
  })
  it('a block that only changes its structural role marks no tile as one where sand flips', () => {
    // Blocks: 0 stone (fixed), 4 beam (a structural member); both solid, neither falls.
    const sim = makeWide(64), nav = sim.workers!.nav, flips = nav.flips
    cmd(sim, { type: 'setBlock', pos: [20, 3, 20], voxel: 5 })
    expect(sim.store.getVoxel(20, 3, 20) & 0xfff).toBe(5)
    expect(nav.flips).toBe(flips)
  })
})
