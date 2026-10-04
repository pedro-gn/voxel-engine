import { describe, expect, it, vi } from 'vitest'
import { defineBlock } from '../src/blocks/registry.ts'
import type { Command } from '../src/sim/commands.ts'
import { Pcg32, hash32 } from '../src/sim/rng.ts'
import { defineRules } from '../src/sim/rules.ts'
import { Simulation } from '../src/sim/simulation.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { WorldFullError } from '../src/world/chunkStore.ts'
import { AIR } from '../src/world/voxel.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'

const BLOCKS = [...TEST_BLOCKS, defineBlock({ name: 'sand' }), defineBlock({ name: 'bomb' }), defineBlock({ name: 'spawner' })]
const SAND = 8
const BOMB = 9
const SPAWNER = 10

type Positions = [number, number, number][]

const rules = defineRules({
  blocks: {
    sand: {
      onNeighborChanged(ctx, x, y, z) { ctx.schedule(x, y, z, 2) },
      onScheduledTick(ctx, x, y, z, v) {
        if (y > 0 && ctx.isAir(ctx.get(x, y - 1, z))) { ctx.set(x, y, z, AIR); ctx.set(x, y - 1, z, v) }
      },
    },
    bomb: { onNeighborChanged() { throw new Error('boom') } },
    // Places stone above itself when its scheduled update runs: 1 scheduled update + 7 notifications.
    spawner: { onScheduledTick(ctx, x, y, z) { ctx.set(x, y + 1, z, ctx.id('stone')) } },
  },
  commands: {
    ping(ctx, cmd) { ctx.emit('pong', (cmd as unknown as { n: number }).n) },
    roll(ctx) { ctx.emit('roll', ctx.random()) },
    kick(ctx, cmd) {
      const c = cmd as unknown as { positions: Positions; delay: number }
      for (const [x, y, z] of c.positions) ctx.schedule(x, y, z, c.delay)
    },
    setThenThrow(ctx) {
      ctx.set(3, 3, 3, ctx.id('stone'))
      throw new Error('half done')
    },
  },
})

function makeSim(opts: { workCap?: number; log?: (m: string) => void; commandLogLimit?: number; maxPages?: number } = {}) {
  return new Simulation({ buffers: createWorldBuffers([64, 64, 64]), blocks: BLOCKS, rules, seed: 42, ...opts })
}

function allEven(sim: Simulation): boolean {
  return Array.from(sim.store.versions).every((v) => (v & 1) === 0)
}

describe('Simulation', () => {
  it('applies commands on the next step and acks them', () => {
    const sim = makeSim()
    sim.submit(1, 0, { type: 'setBlock', pos: [5, 5, 5], voxel: ID.stone })
    expect(sim.store.getVoxel(5, 5, 5)).toBe(AIR)
    const r = sim.step()
    expect(r.tick).toBe(0)
    expect(sim.tick).toBe(1)
    expect(sim.store.getVoxel(5, 5, 5)).toBe(ID.stone)
    expect(r.acks).toEqual([{ clientId: 1, seq: 0, ok: true }])
    expect(r.dirtyChunks).toContain(0)
    expect(sim.commandLog.map((c) => [c.tick, c.clientId, c.seq])).toEqual([[0, 1, 0]])
  })

  it('rejects invalid commands without touching the world or the log', () => {
    const sim = makeSim()
    sim.submit(1, 3, { type: 'setBlock', pos: [0, 64, 0], voxel: ID.stone })
    const r = sim.step()
    expect(r.acks[0]).toMatchObject({ clientId: 1, seq: 3, ok: false })
    expect(r.acks[0]!.error).toMatch(/out of bounds/)
    expect(sim.commandLog).toEqual([])
  })

  it('rejects non-object commands with an ack error instead of crashing', () => {
    const sim = makeSim()
    sim.submit(1, 0, null as unknown as Command)
    sim.submit(1, 1, 'setBlock' as unknown as Command)
    sim.submit(1, 2, { type: 'setBlock', pos: [1, 1, 1], voxel: ID.stone })
    const r = sim.step()
    expect(r.acks.map((a) => [a.seq, a.ok])).toEqual([[0, false], [1, false], [2, true]])
    expect(r.acks[0]!.error).toMatch(/command must be an object/)
    expect(sim.commandLog.map((c) => c.seq)).toEqual([2])
  })

  it('runs scheduled rules: sand falls to the floor', () => {
    const sim = makeSim()
    sim.submit(1, 0, { type: 'setBlock', pos: [5, 10, 5], voxel: SAND })
    for (let i = 0; i < 40; i++) sim.step()
    expect(sim.store.getVoxel(5, 10, 5)).toBe(AIR)
    expect(sim.store.getVoxel(5, 0, 5)).toBe(SAND)
  })

  it('keeps going when a rule throws, logs it, and leaves no seqlock odd', () => {
    const logs: string[] = []
    const sim = makeSim({ log: (m) => logs.push(m) })
    sim.submit(1, 0, { type: 'setBlock', pos: [6, 10, 5], voxel: BOMB })
    sim.submit(1, 1, { type: 'setBlock', pos: [5, 10, 5], voxel: SAND })
    for (let i = 0; i < 40; i++) {
      sim.step()
      expect(allEven(sim)).toBe(true)
    }
    expect(sim.store.getVoxel(5, 0, 5)).toBe(SAND)
    expect(logs.some((l) => /rule error block=bomb pos=\(6,10,5\) tick=0: boom/.test(l))).toBe(true)
  })

  it('closes every seqlock even when a fatal WorldFullError escapes the tick', () => {
    const sim = makeSim({ maxPages: 0 })
    sim.submit(1, 0, { type: 'setBlock', pos: [5, 5, 5], voxel: ID.stone })
    expect(() => sim.step()).toThrow(WorldFullError)
    expect(allEven(sim)).toBe(true)
    expect(sim.tick).toBe(1)
  })

  it('delivers custom commands and emitted events', () => {
    const sim = makeSim()
    sim.submit(2, 0, { type: 'ping', n: 7 })
    expect(sim.step().events).toEqual([{ tick: 0, type: 'pong', payload: 7 }])
  })

  it('logs a command whose handler throws after a set, so replay reproduces the partial effect', () => {
    const logs: string[] = []
    const live = makeSim({ log: (m) => logs.push(m) })
    live.submit(1, 0, { type: 'setBlock', pos: [10, 10, 10], voxel: SAND })
    live.submit(1, 1, { type: 'setThenThrow' })
    const r = live.step()
    expect(r.acks).toEqual([
      { clientId: 1, seq: 0, ok: true },
      { clientId: 1, seq: 1, ok: false, error: 'half done' },
    ])
    expect(live.store.getVoxel(3, 3, 3)).toBe(ID.stone)
    expect(live.commandLog.map((c) => c.seq)).toEqual([0, 1])
    expect(logs.some((l) => /command error type=setThenThrow tick=0: half done/.test(l))).toBe(true)
    for (let i = 0; i < 20; i++) live.step()

    const replay = makeSim({ log: () => {} })
    for (let i = 0; i < 21; i++) {
      for (const c of live.commandLog) if (c.tick === replay.tick) replay.submit(c.clientId, c.seq, c.cmd)
      replay.step()
    }
    expect(replay.store.getVoxel(3, 3, 3)).toBe(ID.stone)
    expect(replay.hash()).toBe(live.hash())
  })

  it('caps work per tick by count and carries the rest over', () => {
    const sim = makeSim({ workCap: 5 })
    // 1 <= x <= 28, y = 20, z = 5: every block has all 6 neighbours in bounds, so 7 notifications each.
    for (let i = 0; i < 10; i++) sim.submit(1, i, { type: 'setBlock', pos: [i * 3 + 1, 20, 5], voxel: ID.stone })
    sim.step()
    expect(sim.pendingWork).toBe(70 - 5)
    sim.step()
    expect(sim.pendingWork).toBe(70 - 10)
  })

  it('drains scheduled updates lazily so their notifications share the same cap', () => {
    const sim = makeSim({ workCap: 8 })
    const spawners: Positions = [[10, 10, 10], [20, 10, 10], [30, 10, 10]]
    spawners.forEach((pos, i) => sim.submit(1, i, { type: 'setBlock', pos, voxel: SPAWNER }))
    sim.step()
    while (sim.pendingWork > 0) sim.step() // 21 notifications, 8 per tick
    expect(sim.tick).toBe(3)
    sim.submit(1, 3, { type: 'kick', positions: spawners, delay: 1 })
    sim.step()
    expect(sim.pendingWork).toBe(3) // all three due next tick
    // Each tick: 1 scheduled update + its 7 notifications = 8 = the cap, so one spawner fires per tick.
    const stonesAbove = () => spawners.filter(([x, y, z]) => sim.store.getVoxel(x, y + 1, z) === ID.stone).length
    for (const [pending, stones] of [[2, 1], [1, 2], [0, 3]] as const) {
      sim.step()
      expect(sim.pendingWork).toBe(pending)
      expect(stonesAbove()).toBe(stones)
    }
  })

  it('schedules relative to the current tick with a minimum delay of 1', () => {
    const sim = makeSim()
    sim.submit(1, 0, { type: 'setBlock', pos: [10, 10, 10], voxel: SPAWNER })
    sim.submit(1, 1, { type: 'setBlock', pos: [20, 10, 10], voxel: SPAWNER })
    sim.step()
    sim.step() // tick 1
    sim.submit(1, 2, { type: 'kick', positions: [[10, 10, 10]], delay: 3 })
    sim.submit(1, 3, { type: 'kick', positions: [[20, 10, 10]], delay: 0 })
    sim.step() // tick 2: due ticks 5 and 3
    sim.step() // tick 3
    expect(sim.store.getVoxel(20, 11, 10)).toBe(ID.stone)
    expect(sim.store.getVoxel(10, 11, 10)).toBe(AIR)
    sim.step() // tick 4
    expect(sim.store.getVoxel(10, 11, 10)).toBe(AIR)
    sim.step() // tick 5
    expect(sim.store.getVoxel(10, 11, 10)).toBe(ID.stone)
  })

  it('seeds one random stream per tick from hash32(seed, tick)', () => {
    const sim = makeSim()
    sim.submit(1, 0, { type: 'roll' })
    const r0 = sim.step()
    for (let i = 0; i < 4; i++) sim.step()
    sim.submit(1, 1, { type: 'roll' })
    const r5 = sim.step()
    expect(r0.events).toEqual([{ tick: 0, type: 'roll', payload: new Pcg32(hash32(42, 0)).next() }])
    expect(r5.events).toEqual([{ tick: 5, type: 'roll', payload: new Pcg32(hash32(42, 5)).next() }])
  })

  it('trims the command log in batches, keeping the newest entries', () => {
    const sim = makeSim({ commandLogLimit: 10 })
    for (let i = 0; i < 11; i++) sim.submit(1, i, { type: 'ping', n: i })
    sim.step()
    expect(sim.commandLog).toHaveLength(11) // 11 <= 1.1 * 10: no trim yet
    sim.submit(1, 11, { type: 'ping', n: 11 })
    sim.step()
    expect(sim.commandLog.map((c) => c.seq)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  it('notifies only the shell of a fillRegion', () => {
    const sim = makeSim()
    sim.submit(1, 0, { type: 'fillRegion', min: [0, 0, 0], max: [9, 9, 9], voxel: ID.stone })
    sim.step()
    expect(sim.store.getVoxel(9, 9, 9)).toBe(ID.stone)
    expect(sim.pendingWork).toBe(0) // all shell notifications fit in the default cap
  })

  it('queues exactly the shell notifications of a fillRegion', () => {
    const sim = makeSim({ workCap: 1 })
    sim.submit(1, 0, { type: 'fillRegion', min: [0, 0, 0], max: [9, 9, 9], voxel: ID.stone })
    sim.step()
    // Shell = 10³ − 8³ = 488 voxels, 7 notifications each (self + 6 neighbours) = 3416.
    // The 100 shell voxels on each of the x = 0, y = 0 and z = 0 faces lose one out-of-bounds
    // neighbour: −300 → 3116 queued. The cap of 1 consumes one. (Notifying all 1000 voxels: 6699.)
    expect(sim.pendingWork).toBe(3116 - 1)
  })

  it('rejects rules for unknown blocks at construction', () => {
    expect(() => new Simulation({
      buffers: createWorldBuffers([32, 32, 32]), blocks: BLOCKS, seed: 1,
      rules: defineRules({ blocks: { nope: {} } }),
    })).toThrow(/unknown block "nope"/)
  })

  it('hashes world state', () => {
    const a = makeSim(), b = makeSim()
    expect(a.hash()).toBe(b.hash())
    a.submit(1, 0, { type: 'setBlock', pos: [1, 1, 1], voxel: ID.stone })
    a.step(); b.step()
    expect(a.hash()).not.toBe(b.hash())
  })
})

describe('rule context reads and write trimming', () => {
  it('reads registry flags, light and liquid levels', () => {
    const seen: Record<string, unknown> = {}
    const r = defineRules({
      commands: {
        probe(ctx) {
          seen.solid = [ctx.isSolid(ID.stone), ctx.isSolid(ID.water), ctx.isSolid(AIR)]
          seen.liquid = [ctx.isLiquid(ID.water), ctx.isLiquid(ID.stone)]
          seen.opaque = [ctx.isOpaque(ID.stone), ctx.isOpaque(ID.glass)]
          seen.falls = [ctx.falls(SAND), ctx.falls(ID.stone)]
          seen.level = [ctx.level(ctx.withState(ID.water, 3)), ctx.level(ID.stone)]
          seen.sky = ctx.skyLight(10, 60, 10)
          seen.block = ctx.blockLight(10, 60, 10)
        },
      },
    })
    const blocks = [...TEST_BLOCKS, defineBlock({ name: 'sand', falls: true })]
    const sim = new Simulation({ buffers: createWorldBuffers([64, 64, 64]), blocks, rules: r, seed: 1 })
    sim.submit(1, 0, { type: 'probe' })
    sim.step()
    expect(seen).toEqual({
      solid: [true, false, false], liquid: [true, false], opaque: [true, false], falls: [true, false],
      level: [3, -1], sky: 15, block: 0,
    })
  })
  it('does not relight when only a block state changes', () => {
    const sim = makeSim()
    // Walled in below and on the sides, so the water automaton leaves the cell alone.
    const walls = [[5, 4, 5], [4, 5, 5], [6, 5, 5], [5, 5, 4], [5, 5, 6]] as const
    walls.forEach(([x, y, z], i) => sim.submit(1, i, { type: 'setBlock', pos: [x, y, z], voxel: ID.stone }))
    sim.submit(1, 5, { type: 'setBlock', pos: [5, 5, 5], voxel: ID.water })
    sim.step()
    const spy = vi.spyOn(sim.light, 'onVoxelChanged')
    sim.submit(1, 6, { type: 'setBlock', pos: [5, 5, 5], voxel: (3 << 12) | ID.water })
    sim.step()
    expect(spy).not.toHaveBeenCalled()
    expect(sim.store.getVoxel(5, 5, 5)).toBe((3 << 12) | ID.water)
  })
  it('reports physics busy while fluid moves or a job is queued, and idle once settled', () => {
    const sim = makeSim()
    expect(sim.step().physics).toMatchObject({ active: 0, jobs: 0, busy: false })
    sim.submit(1, 0, { type: 'setBlock', pos: [5, 20, 5], voxel: ID.water })
    sim.step()
    expect(sim.step().physics.busy).toBe(true)
    let busy = true
    for (let i = 0; i < 2000 && busy; i++) busy = sim.step().physics.busy
    expect(busy).toBe(false)
    let left = 2
    sim.jobs.start({ kind: 't', done: false, step() { if (--left === 0) (this as { done: boolean }).done = true; return 1 }, finish() {}, reset() {}, mixState() {} })
    expect(sim.step().physics).toMatchObject({ jobs: 1, busy: true })
    expect(sim.step().physics).toMatchObject({ jobs: 0, busy: false })
  })
  it('queues no neighbour notifications when no block listens for them', () => {
    const quiet = defineRules({ blocks: { grass: { onRandomTick() {} } } })
    const sim = new Simulation({ buffers: createWorldBuffers([64, 64, 64]), blocks: TEST_BLOCKS, rules: quiet, seed: 1 })
    sim.submit(1, 0, { type: 'fillRegion', min: [0, 0, 0], max: [9, 9, 9], voxel: ID.stone })
    sim.step()
    expect(sim.pendingWork).toBe(0)
  })
})

describe('region jobs and pause', () => {
  it('bumps a chunk epoch on every voxel write', () => {
    const sim = makeSim()
    const ci = sim.layout.chunkOf(5, 5, 5)
    const e0 = sim.epochs[ci]!
    sim.submit(1, 0, { type: 'setBlock', pos: [5, 5, 5], voxel: ID.stone })
    sim.step()
    expect(sim.epochs[ci]).toBe(e0 + 1)
  })
  it('runs region jobs in the tick, and not while paused', () => {
    const sim = makeSim()
    let steps = 0
    sim.jobs.start({ kind: 't', done: false, step() { steps++; (this as { done: boolean }).done = true; return 1 }, finish() {}, reset() {}, mixState() {} })
    sim.setPaused(true)
    sim.step()
    expect([sim.paused, steps]).toEqual([true, 0])
    sim.setPaused(false)
    sim.step()
    expect(steps).toBe(1)
  })
})
