import { describe, expect, it } from 'vitest'
import { BlockRegistry } from '../src/blocks/registry.ts'
import { NavigationSystem } from '../src/sim/navigation/navigation.ts'
import { Simulation } from '../src/sim/simulation.ts'
import type { GameSystem, SystemContext } from '../src/sim/systems.ts'
import { ReservationTable } from '../src/sim/workers/reservations.ts'
import { SpaceTimeSearch, type SpaceTimePort } from '../src/sim/workers/spaceTime.ts'
import type { UnitEvent } from '../src/sim/workers/types.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { Layout } from '../src/world/layout.ts'
import { AIR } from '../src/world/voxel.ts'
import { B, WATER_BLOCKS, fillGenerator, w } from './waterHelpers.ts'

/**
 * A stream in a channel, as on the colony's island: ground top 7 (feet 8); banks z 29–30 and 34–35 (x ≥ 18) top 8, so a
 * unit stands on them at y 9; the channel z 31–33 (x ≥ 20) has its bed at 6, so its floor (y 7) is two below the banks:
 * a unit can drop in but never climb out. `level` puts water of that level (0–7) on the floor; -1 leaves it dry. With
 * `ledge`, a wall stands on z ≤ 29 (x ≥ 18): the near bank is a ledge one pose wide between the wall and the channel.
 */
function stream(level: number, ledge = false) {
  const events: UnitEvent[] = []
  let script: ((c: SystemContext) => void) | null = null
  let ctx!: SystemContext
  const sys: GameSystem = { name: 'test', version: 1, snapshot: () => null, tick: c => { ctx = c; events.push(...c.units.events); const s = script; script = null; s?.(c) } }
  const sim = new Simulation({ buffers: createWorldBuffers([64, 32, 64]), blocks: WATER_BLOCKS, seed: 1, randomTicksPerChunk: 0, log: () => {}, systems: [sys], workers: {} })
  const gen = fillGenerator((x, y, z) => {
    const channel = x >= 20 && z >= 31 && z <= 33, banks = x >= 18 && z >= 29 && z <= 35
    if (y <= (channel ? 6 : banks ? 8 : 7) || ledge && x >= 18 && z <= 29 && y <= 11) return B.stone
    return channel && y === 7 && level >= 0 ? w(level) : AIR
  })
  sim.configure(gen, null)
  sim.generate(gen)
  // The water sim's heightfield is authoritative: let it settle before anyone walks.
  for (let i = 0; i < 2000 && sim.step().physics.busy; i++);
  const run = <T>(s: (c: SystemContext) => T): T => { let out!: T; script = c => { out = s(c) }; sim.step(); return out }
  const inChannel = (id: number) => { const v = ctx.units.view(id)!; return v.z256 >> 8 >= 31 && v.z256 >> 8 <= 33 && v.y256 < 9 * 256 }
  /** Steps `ticks` ticks; the ids of units that were ever in the channel. */
  const watch = (ids: number[], ticks: number) => { const fell = new Set<number>(); for (let t = 0; t < ticks; t++) { sim.step(); for (const id of ids) if (inChannel(id)) fell.add(id) } return [...fell] }
  return { sim, events, run, watch, get ctx() { return ctx } }
}

describe('a unit never walks into a pit it cannot climb out of', () => {
  for (const [name, level] of [['shallow water', 1], ['a dry trench', -1]] as const) {
    it(`passing an idle unit on the bank next to ${name}`, () => {
      const h = stream(level)
      if (level >= 0) expect(h.sim.water.depthAt(25, 7, 32)).toBeGreaterThan(0)
      // The idle unit stands on the lane beside the channel; the walker's route runs through it along the bank.
      const [walker, idle] = h.run(c => [c.units.spawn([20, 9, 30]), c.units.spawn([25, 9, 30])])
      h.run(c => c.units.goTo(walker!, [32, 9, 30]))
      expect(h.watch([walker!, idle!], 1500)).toEqual([])
      expect(h.events).toContainEqual({ unit: walker, type: 'arrived' })
      expect(h.events.filter(e => e.type === 'failed')).toEqual([])
    })
    it(`idle units making way next to ${name} keep to the banks`, () => {
      const h = stream(level)
      const ids = h.run(c => [c.units.spawn([20, 9, 30]), c.units.spawn([25, 9, 30]), c.units.spawn([25, 9, 29]), c.units.spawn([27, 9, 30])])
      h.run(c => c.units.goTo(ids[0]!, [32, 9, 30]))
      expect(h.watch(ids, 1500)).toEqual([])
      expect(h.events).toContainEqual({ unit: ids[0], type: 'arrived' })
    })
  }

  it('an idle unit making way on a one-wide ledge keeps to the ledge, not down into the channel', () => {
    // No refuge off the walker's route is in reach of one window (the channel is no refuge: no way back), so the idle
    // unit is sent to make way: the nearest free pose off that route it can walk back from.
    const h = stream(1, true)
    const [walker, idle] = h.run(c => [c.units.spawn([20, 9, 30]), c.units.spawn([30, 9, 30])])
    h.run(c => c.units.goTo(walker!, [42, 9, 30]))
    expect(h.watch([walker!, idle!], 1500)).toEqual([])
    expect(h.events).toContainEqual({ unit: walker, type: 'arrived' })
  })

  it('a unit already in the pit fails its goTo with no-access, once, and stays put', () => {
    const h = stream(1)
    const id = h.run(c => c.units.spawn([25, 7, 32]))
    h.run(c => c.units.goTo(id, [32, 9, 30]))
    h.watch([id], 300)
    expect(h.events).toEqual([{ unit: id, type: 'failed', reason: 'no-access' }])
    expect(h.ctx.units.view(id)!.intent).toBeNull()
  })
})

describe('local moves off the route take only steps they can take back', () => {
  /**
   * A corridor along x at z 0 with a side pocket at (3, 1). A pocket in `pits` is entered but has no step out (a drop
   * the body cannot climb back).
   */
  function corridor(pits: Set<number>) {
    const W = 8, idx = (x: number, z: number) => x + z * W
    const open = (x: number, z: number) => x >= 0 && x < W && (z === 0 || z === 1 && x === 3)
    const port: SpaceTimePort = {
      neighbor: (p, d) => { const x = p % W + [1, -1, 0, 0][d]!, z = Math.floor(p / W) + [0, 0, 1, -1][d]!; return open(x, z) && !pits.has(p) ? idx(x, z) : -1 },
      allowed: () => true, cellsOf: p => [p], stepCells: (a, b) => [a, b], ticksOf: () => 4, coords: p => [p % W, 0, Math.floor(p / W)],
    }
    return { port, idx }
  }
  const run = (s: SpaceTimeSearch) => { while (s.status === 'pending') s.step(64); return s }
  /** A unit with the right of way sweeps the corridor from its far end, one step after the start. */
  const sweep = (idx: (x: number, z: number) => number) => {
    const table = new ReservationTable(32)
    for (let k = 0; k <= 7; k++) for (let t = 4 * k + 4; t <= 4 * k + 8; t++) table.reserve(2, t, [idx(7 - k, 0)])
    return table
  }

  it('a repair never backs off into a pocket it cannot leave', () => {
    const two = corridor(new Set()), targets = [1, 2, 3, 4, 5, 6, 7].map(x => two.idx(x, 0))
    const found = run(new SpaceTimeSearch(two.port, sweep(two.idx), 1, two.idx(0, 0), 0, targets))
    expect(found.plan!.steps.some(s => s.pose === two.idx(3, 1))).toBe(true) // a pocket it can leave is fine
    // The same pocket, entered by a drop: no step leads back out of it.
    const pit = two.idx(3, 1), one = corridor(new Set([pit]))
    const s = run(new SpaceTimeSearch(one.port, sweep(one.idx), 1, one.idx(0, 0), 0, targets))
    expect(s.plan?.steps.some(st => st.pose === pit) ?? false).toBe(false)
  })

  it('a repair still takes the route\'s own one-way step', () => {
    const W = 8
    // The route drops from x 3 to x 4: there is no step back from 4 to 3.
    const port: SpaceTimePort = {
      neighbor: (p, d) => { const x = p + [1, -1, 0, 0][d]!; return d > 1 || x < 0 || x >= W || p === 4 && x === 3 ? -1 : x },
      allowed: () => true, cellsOf: p => [p], stepCells: (a, b) => [a, b], ticksOf: () => 4, coords: p => [p, 0, 0],
    }
    const s = run(new SpaceTimeSearch(port, new ReservationTable(32), 1, 0, 0, [1, 2, 3, 4, 5, 6, 7]))
    expect(s.status).toBe('found'); expect(s.plan!.rejoin).toBe(6)
  })

  it('a repair may leave the route by a one-way step when it rejoins the route after it', () => {
    // Two lanes (z 0 and z 1) with a one-way drop from x 3 to x 4 in both; a still unit holds (4, 0) and (5, 0), on the
    // route. The side lane passes it: down the drop beside the route, then back onto the route and on to its end at x 7.
    const W = 8, idx = (x: number, z: number) => x + z * W
    const port: SpaceTimePort = {
      neighbor: (p, d) => { const x = p % W + [1, -1, 0, 0][d]!, z = Math.floor(p / W) + [0, 0, 1, -1][d]!; return x < 0 || x >= W || z < 0 || z > 1 || p % W === 4 && x === 3 ? -1 : idx(x, z) },
      allowed: () => true, cellsOf: p => [p], stepCells: (a, b) => [a, b], ticksOf: () => 4, coords: p => [p % W, 0, Math.floor(p / W)],
    }
    const table = new ReservationTable(32)
    table.hold(2, [idx(4, 0), idx(5, 0)])
    const s = run(new SpaceTimeSearch(port, table, 1, idx(2, 0), 0, [3, 4, 5, 6, 7].map(x => idx(x, 0))))
    expect(s.status).toBe('found')
    expect(s.plan!.rejoin).toBe(4)
    expect(s.plan!.steps.some(st => st.pose === idx(4, 1))).toBe(true)
  })

  it('a reversible flat search goes round a pit instead of dropping into it', () => {
    // Ground solid up to y 5 (feet 6) but a pit x 11–13 × z 9–11 open down to y 3 (its floor, feet 4, is two below).
    const layout = new Layout([32, 32, 32]), registry = new BlockRegistry([{ name: 'stone' }])
    const pit = (x: number, z: number) => x >= 11 && x <= 13 && z >= 9 && z <= 11
    const nav = new NavigationSystem({ layout, registry, get: (x, y, z) => y < 4 || y < 6 && !pit(x, z) ? 1 : 0 })
    const start = layout.voxelIndex(10, 6, 10), east = (p: number) => layout.voxelCoords(p)[0] >= 11
    const find = (reversible: boolean) => {
      const s = nav.request(start, [], undefined, { accept: east, reversible })
      while (s.status === 'pending') nav.step(256)
      return s.result()
    }
    expect(layout.voxelCoords(find(false).path.at(-1)!)[1]).toBe(4) // the plain search drops in: the nearest pose east
    const r = find(true)
    expect(r.status).toBe('found')
    expect(r.path.every(p => layout.voxelCoords(p)[1] === 6)).toBe(true)
  })
})
