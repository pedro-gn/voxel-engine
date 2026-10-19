import { describe, expect, it } from 'vitest'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import type { Command } from '../src/sim/commands.ts'
import type { WorkerOptions } from '../src/sim/workers/types.ts'
import type { GeneratorContext } from '../src/sim/generator.ts'
import type { SimSnapshot } from '../src/sim/snapshot.ts'
import { toRestore } from './persistHelpers.ts'

// Block ids: 1 stone, 2 planks, 3 water, 4 road, 5 paving.
const blocks = [{ name: 'stone' }, { name: 'planks' }, { name: 'water', liquid: true }, { name: 'road' }, { name: 'paving' }]
const ROAD = 4, PAVING = 5
const materials = { stone: { digTicks: 4, buildTicks: 3 }, planks: { digTicks: 2, buildTicks: 3 } }
type Extra = (ctx: GeneratorContext, cx: number, cz: number) => void

/** A side × 32 × side stone floor (y < 4), `extra` drawn over it, and the scale target's navigation budget. */
function world(side: number, extra?: Extra, options: WorkerOptions = {}, from?: SimSnapshot): Simulation {
  const sim = new Simulation({ buffers: createWorldBuffers([side, 32, side]), blocks, seed: 1, randomTicksPerChunk: 0, log: () => {}, workers: { searchCap: 32768, materials, ...options } })
  if (from) sim.restore(toRestore(from))
  else sim.generate({ generateColumn(ctx, cx, cz) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) ctx.set(x, y, z, 1); extra?.(ctx, cx, cz) } })
  return sim
}
/** Sets the floor block (y = 3) of every world column (x, z) that `pick` names. */
const floor = (pick: (x: number, z: number) => number | 0): Extra => (ctx, cx, cz) => {
  for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) { const b = pick(cx * 32 + x, cz * 32 + z); if (b) ctx.set(x, 3, z, b) }
}
let seq = 0
function cmd(sim: Simulation, command: Command) { sim.submit(0, ++seq, command); const r = sim.step(); expect(r.acks[0]?.ok, r.acks[0]?.error).toBe(true); return r }
function spawn(sim: Simulation, pos: number[]) { cmd(sim, { type: 'unitSpawn', pos }); return sim.workers!.units.size }
/** Moves unit `id` to `goal`; returns the ticks from the command to standing idle there, and the farthest z it reached. */
function walk(sim: Simulation, id: number, goal: [number, number, number], cap = 3000, each?: () => void) {
  const t0 = sim.tick
  cmd(sim, { type: 'unitMove', ids: [id], pos: goal })
  let maxZ = 0
  for (let i = 0; i < cap; i++) {
    const v = sim.workers!.view(id)!
    maxZ = Math.max(maxZ, v.z256 >> 8)
    if (v.state === 'idle' && v.x256 === goal[0] * 256 + 128 && v.z256 === goal[2] * 256 + 128) break
    sim.step(); each?.()
  }
  const v = sim.workers!.view(id)!
  expect([v.state, v.x256 >> 8, v.y256 >> 8, v.z256 >> 8]).toEqual(['idle', ...goal])
  return { ticks: sim.tick - t0, maxZ }
}

/** A 20-cell straight walk along x at z = 10 (x 10 → 30), on floors that `pick` sets. */
function straight(pick: (x: number, z: number) => number | 0, options: WorkerOptions = {}): number {
  const sim = world(64, floor(pick), options)
  const id = spawn(sim, [10, 4, 10])
  return walk(sim, id, [30, 4, 10]).ticks
}
const FAST = { road: { speed: 1.6 } }

describe('surface speed', { timeout: 60_000 }, () => {
  // Measured on 571d935 (before surface speeds existed): the 20-cell walk, and the lake routes' trajectory hash.
  const WALK_AT_571 = 82, LAKE_AT_571 = 55634351

  it('unset is identical: a 20-cell walk takes the pinned ticks and the lake routes keep their trajectory', () => {
    expect(straight(() => 0)).toBe(WALK_AT_571)
    expect(straight(() => 0, { surfaces: {} })).toBe(WALK_AT_571)
    // The workersRoutes lake fixture: a one-deep lake (x 100..110, z 0..10) that both units walk round.
    const sim = world(256, (ctx, cx, cz) => {
      for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) { const wx = cx * 32 + x, wz = cz * 32 + z; if (wx >= 100 && wx <= 110 && wz <= 10) ctx.set(x, 3, z, 3 | (7 << 12)) }
    })
    spawn(sim, [60, 4, 5]); spawn(sim, [95, 4, 5])
    cmd(sim, { type: 'unitMove', ids: [1], pos: [160, 4, 5] }); cmd(sim, { type: 'unitMove', ids: [2], pos: [115, 4, 5] })
    const units = [...sim.workers!.units.values()]
    let h = 0x811c9dc5
    const mix = (n: number) => { h = Math.imul(h ^ (n & 0xffff), 16777619) >>> 0; h = Math.imul(h ^ (n >>> 16), 16777619) >>> 0 }
    for (let i = 0; i < 3000 && units.some(u => u.goal !== null); i++) { sim.step(); for (const u of units) { mix(u.x); mix(u.y); mix(u.z) } }
    mix(sim.tick)
    expect(units.every(u => u.goal === null)).toBe(true)
    expect(h).toBe(LAKE_AT_571)
  })

  it('a straight walk over fast blocks is faster by their speed, cell by cell', () => {
    const overhead = WALK_AT_571 - 80
    const all16 = straight(() => ROAD, { surfaces: FAST })
    expect(Math.abs(all16 - overhead - Math.ceil(80 / 1.6))).toBeLessThanOrEqual(1)
    const all13 = straight(() => ROAD, { surfaces: { road: { speed: 1.3 } } })
    expect(Math.abs(all13 - overhead - Math.ceil(80 / 1.3))).toBeLessThanOrEqual(1)
    const half = straight(x => x >= 20 ? ROAD : 0, { surfaces: FAST })
    expect(half).toBeGreaterThan(all16 + 2)
    expect(half).toBeLessThan(WALK_AT_571 - 2)
    // Configured but not underfoot: today's timing.
    expect(straight(() => 0, { surfaces: FAST })).toBe(WALK_AT_571)
  })

  /** A goal `len` cells straight across neutral ground, and a detour 3 cells aside (len + 6 cells) on `speed` blocks. */
  function detour(len: number, speed: number) {
    const x0 = 10, x1 = 10 + len, z0 = 10, lane = 13
    const pick = (x: number, z: number) => (z === lane && x >= x0 && x <= x1) || ((x === x0 || x === x1) && z > z0 && z <= lane) ? ROAD : 0
    const sim = world(len > 40 ? 128 : 64, floor(pick), { surfaces: { road: { speed } } })
    const id = spawn(sim, [x0, 4, z0])
    return walk(sim, id, [x1, 4, z0])
  }

  it('routes choose by time: a longer fast detour wins when it is faster, and loses when it is not', () => {
    const fast = detour(20, 1.6)
    expect(fast.maxZ).toBe(13)
    expect(fast.ticks).toBeLessThan(WALK_AT_571)
    expect(detour(20, 1.1).maxZ).toBe(10)
    // Far enough for the region layer (hierarchical routes, weighted: near ties such as 1.1 are not pinned there).
    const far = detour(80, 1.6)
    expect(far.maxZ).toBe(13)
    expect(far.ticks).toBeLessThan(80 * 4)
  })

  it('a swap of solid blocks invalidates routes: the next route uses the new fast lane, and no unit stands in a solid cell', () => {
    const lane = 13, x0 = 10, x1 = 90
    const sim = world(128, undefined, { surfaces: { road: { speed: 1.6 }, paving: { speed: 1 } } })
    const id = spawn(sim, [x0, 4, 10])
    const solidAt = () => { const v = sim.workers!.view(id)!, x = v.x256 >> 8, y = v.y256 >> 8, z = v.z256 >> 8; return sim.registry.solid[sim.store.getVoxel(x, y, z) & 0xfff] || sim.registry.solid[sim.store.getVoxel(x, y + 1, z) & 0xfff] }
    // There and back on plain stone first: routes and region records are built and cached.
    expect(walk(sim, id, [x1, 4, 10]).maxZ).toBe(10)
    cmd(sim, { type: 'unitMove', ids: [id], pos: [x0, 4, 10] })
    for (let i = 0; i < 30; i++) sim.step()
    // Mid-walk, the lane's floor goes from stone to the fast block (solid to solid).
    cmd(sim, { type: 'fillRegion', min: [x0, 3, lane], max: [x1, 3, lane], voxel: ROAD })
    cmd(sim, { type: 'fillRegion', min: [x0, 3, 11], max: [x0, 3, lane], voxel: ROAD })
    cmd(sim, { type: 'fillRegion', min: [x1, 3, 11], max: [x1, 3, lane], voxel: ROAD })
    let inside = 0
    const back = walk(sim, id, [x0, 4, 10], 3000, () => { if (solidAt()) inside++ })
    expect(inside).toBe(0)
    // The next route plans on the new floor.
    const there = walk(sim, id, [x1, 4, 10], 3000, () => { if (solidAt()) inside++ })
    expect(there.maxZ).toBe(lane)
    expect(inside).toBe(0)
    expect(back.ticks).toBeGreaterThan(0)
  })

  it('a climb onto a fast block still takes 6 ticks', () => {
    const sim = world(64, (ctx, cx, cz) => { if (!cx && !cz) { ctx.set(12, 4, 10, ROAD); for (let x = 12; x <= 14; x++) ctx.set(x, 4, 10, ROAD) } }, { surfaces: FAST })
    const id = spawn(sim, [10, 4, 10])
    cmd(sim, { type: 'unitMove', ids: [id], pos: [14, 5, 10] })
    const u = sim.workers!.units.get(id)!
    let climb = -1
    for (let i = 0; i < 200 && climb < 0; i++) { sim.step(); const m = u.motion; if (m && !m.flat) climb = m.ticks }
    expect(climb).toBe(6)
  })

  it('refuses a speed outside (0, 4] or not a number, an unknown block and a block that is not solid', () => {
    for (const speed of [0, -1, NaN, 5, Infinity]) expect(() => world(32, undefined, { surfaces: { road: { speed } } })).toThrow(RangeError)
    expect(() => world(32, undefined, { surfaces: { road: { speed: 4 } } })).not.toThrow()
    expect(() => world(32, undefined, { surfaces: { gravel: { speed: 1.2 } } })).toThrow(RangeError)
    expect(() => world(32, undefined, { surfaces: { gravel: { speed: 1.2 } } })).toThrow('gravel')
    expect(() => world(32, undefined, { surfaces: { water: { speed: 1.2 } } })).toThrow(RangeError)
  })

  /** Saves mid-walk and loads twice; returns how many ticks later than the uninterrupted run the restored unit arrives. */
  function lag(options: WorkerOptions, extra: Extra): number {
    const sim = world(64, extra, options)
    const id = spawn(sim, [10, 4, 10])
    cmd(sim, { type: 'unitMove', ids: [id], pos: [40, 4, 10] })
    for (let i = 0; i < 20; i++) sim.step()
    const snap = sim.snapshot(null)
    const r = world(64, extra, options, snap), q = world(64, extra, options, snap)
    const arrived = (s: Simulation) => { const v = s.workers!.view(id)!; return v.state === 'idle' && v.x256 === 40 * 256 + 128 }
    let at = -1, rAt = -1
    for (let i = 0; i < 400 && (at < 0 || rAt < 0); i++) {
      sim.step(); r.step(); q.step()
      expect(q.hash()).toBe(r.hash())
      if (at < 0 && arrived(sim)) at = i
      if (rAt < 0 && arrived(r)) rAt = i
    }
    expect(at).toBeGreaterThan(0)
    expect(rAt).toBeGreaterThan(0)
    return rAt - at
  }

  // As workSpeed's save (its D8): the engine drops motions and rebuilds routes and claims on a load, so a restored run
  // neither hashes as the uninterrupted one nor arrives on its tick. Two loads of one save replay identically, and the
  // restored unit arrives about as late with surfaces as without (the replanned walk splits into other motions, each
  // rounded up to whole ticks: one tick either way).
  it('survives a save mid-walk: two loads replay identically and the unit arrives about as late as without surfaces', () => {
    const plain = lag({}, () => {}), fast = lag({ surfaces: FAST }, floor(() => ROAD))
    expect(plain).toBeLessThanOrEqual(2)
    expect(Math.abs(fast - plain)).toBeLessThanOrEqual(1)
  })
})

describe('surface speed: engineering and landmark tables (accesses review I3, M1)', { timeout: 120_000 }, () => {
  /** A stone wall at x 8 (y 4..7) across the world, with a 1-cell gap at z 14; stone digs in 50 ticks. */
  const walled: Extra = (ctx, cx, cz) => { if (cx || cz) return; for (let z = 0; z < 32; z++) if (z !== 14) for (let y = 4; y < 8; y++) ctx.set(8, y, z, 1) }
  function digOrWalk(options: WorkerOptions) {
    const sim = new Simulation({ buffers: createWorldBuffers([32, 32, 32]), blocks, seed: 1, randomTicksPerChunk: 0, log: () => {}, workers: { searchCap: 32768, materials: { ...materials, stone: { digTicks: 50, buildTicks: 3 } }, ...options } })
    sim.generate({ generateColumn(ctx, cx, cz) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) ctx.set(x, y, z, 1); walled(ctx, cx, cz) } })
    const id = spawn(sim, [5, 4, 5]), t0 = sim.tick
    cmd(sim, { type: 'unitMove', ids: [id], pos: [11, 4, 5], allowDig: true })
    for (let i = 0; i < 600 && !(sim.workers!.view(id)!.state === 'idle' && sim.workers!.view(id)!.x256 >> 8 === 11); i++) sim.step()
    let dug = 0
    for (let z = 0; z < 32; z++) for (let y = 4; y < 8; y++) if (z !== 14 && (sim.store.getVoxel(8, y, z) & 0xfff) !== 1) dug++
    return { ticks: sim.tick - t0, dug, at: sim.workers!.view(id)!.x256 >> 8 }
  }

  it('a unit moved with allowDig weighs digging against walking alike with and without surfaces (I3)', () => {
    const plain = digOrWalk({}), unused = digOrWalk({ surfaces: { planks: { speed: 1.6 } } })
    expect(plain).toMatchObject({ dug: 0, at: 11 })
    expect(unused).toMatchObject({ dug: 0, at: 11 })
    expect(unused.ticks).toBe(plain.ticks)
  })

  /** A 128-wide world warmed until its regions and landmark tables are ready. */
  function warm(options: WorkerOptions) {
    const sim = world(128, undefined, options)
    const nav = sim.workers!.nav
    for (let i = 0; i < 20000 && !nav.landmarks.current(); i++) nav.prebuild(8192, [])
    expect(nav.landmarks.current()).not.toBeNull()
    return sim
  }

  it('a write that changes only a floor\'s speed keeps the landmark tables; one that changes solidity retires them (M1)', () => {
    const sim = warm({ surfaces: FAST }), nav = sim.workers!.nav
    // Twenty road swaps, one every 20 ticks (a road project): the tables stay current throughout.
    let current = 0
    for (let k = 0; k < 20; k++) {
      cmd(sim, { type: 'fillRegion', min: [10 + k, 3, 40], max: [10 + k, 3, 40], voxel: ROAD })
      for (let i = 0; i < 20; i++) { sim.step(); if (nav.landmarks.current()) current++ }
    }
    expect(current).toBe(20 * 20)
    // A route planned now still takes the new road where it is faster (the bounds stay admissible).
    const id = spawn(sim, [10, 4, 37])
    let maxZ = 0
    cmd(sim, { type: 'unitMove', ids: [id], pos: [29, 4, 37] })
    for (let i = 0; i < 400 && !(sim.workers!.view(id)!.state === 'idle' && sim.workers!.view(id)!.x256 >> 8 === 29); i++) { sim.step(); maxZ = Math.max(maxZ, sim.workers!.view(id)!.z256 >> 8) }
    expect(sim.workers!.view(id)!.x256 >> 8).toBe(29)
    // A block placed (solidity) still retires them.
    cmd(sim, { type: 'fillRegion', min: [60, 4, 60], max: [60, 4, 60], voxel: 1 })
    expect(nav.landmarks.current()).toBeNull()
    expect(maxZ).toBeGreaterThanOrEqual(37)
  })

  it('with no surfaces, a block swap of the same speed keeps the tables and a solidity write retires them, as before', () => {
    const sim = warm({}), nav = sim.workers!.nav
    cmd(sim, { type: 'fillRegion', min: [10, 3, 40], max: [10, 3, 40], voxel: PAVING })
    expect(nav.landmarks.current()).not.toBeNull()
    cmd(sim, { type: 'fillRegion', min: [60, 4, 60], max: [60, 4, 60], voxel: 1 })
    expect(nav.landmarks.current()).toBeNull()
  })
})
