import { describe, expect, it } from 'vitest'
import type { Command, Vec3 } from '../src/sim/commands.ts'
import { defineRules, type RuleContext, type RulesModule } from '../src/sim/rules.ts'
import { Simulation } from '../src/sim/simulation.ts'
import type { GameSystem, SystemContext } from '../src/sim/systems.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'

const blocks = [{ name: 'stone' }, { name: 'sand', falls: true }, { name: 'log' }, { name: 'leaves' }, { name: 'sapling', solid: false }]
const B = { air: 0, stone: 1, sand: 2, log: 3, leaves: 4, sapling: 5 } as const

/** A world with a stone floor (y < 4), worker units, and a `probe` rule command whose context the test reads back. */
function make(rules: RulesModule = {}, size: Vec3 = [32, 32, 32], systems: GameSystem[] = []) {
  let reader: ((ctx: RuleContext) => void) | null = null
  const all: RulesModule = { ...rules, commands: { ...rules.commands, probe: (ctx) => { reader?.(ctx) } } }
  const sim = new Simulation({ buffers: createWorldBuffers(size), blocks, seed: 1, randomTicksPerChunk: 0, log: () => {}, rules: all, systems,
    workers: { materials: { stone: { digTicks: 4, buildTicks: 3 } } } })
  sim.generate({ generateColumn(g) { for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < 4; y++) g.set(x, y, z, B.stone) } })
  sim.step()
  let seq = 0
  const cmd = (c: Command) => { sim.submit(0, ++seq, c); const r = sim.step(); expect(r.acks[0]?.ok, r.acks[0]?.error).toBe(true); return r }
  /** The rule context inside a command of the next step, read through `read` while still inside it. */
  const inRule = <T>(read: (ctx: RuleContext) => T): T => {
    let out!: T
    reader = (ctx) => { out = read(ctx) }
    try { cmd({ type: 'probe' }) } finally { reader = null }
    return out
  }
  return { sim, cmd, inRule }
}

const OUTSIDE: Vec3[] = [[-1, 4, 5], [32, 4, 5], [32, 4, 4], [0, 4, -1], [0, 4, 32], [5, -1, 5], [5, 32, 5], [-1, 4, 6], [31, 4, -1]]

describe('rule context', () => {
  it('reads the world size', () => {
    const h = make({}, [64, 32, 96])
    expect(h.inRule(ctx => ctx.size)).toEqual([64, 32, 96])
  })

  it('sees a unit at its feet and head cells, not beside or above it', () => {
    const h = make()
    h.cmd({ type: 'unitSpawn', pos: [5, 4, 5] })
    const at = (p: Vec3) => h.inRule(ctx => ctx.occupied(...p))
    expect(at([5, 4, 5])).toBe(true)
    expect(at([5, 5, 5])).toBe(true)
    expect(at([6, 4, 5])).toBe(false)
    expect(at([5, 4, 6])).toBe(false)
    expect(at([5, 6, 5])).toBe(false)
    expect(at([5, 3, 5])).toBe(false)
  })

  it('sees a falling block in its cell during the fall, and nothing once it landed', () => {
    const h = make()
    h.cmd({ type: 'setBlock', pos: [10, 20, 10], voxel: B.sand })
    expect(h.sim.gravity.count).toBe(1)
    const column = () => h.inRule(ctx => Array.from({ length: 32 }, (_, y) => ctx.occupied(10, y, 10)))
    const during = column()
    const ys = during.flatMap((o, y) => (o ? [y] : []))
    expect(ys.length).toBeGreaterThan(0)
    expect(ys.length).toBeLessThanOrEqual(2)
    for (const y of ys) expect(y).toBeGreaterThanOrEqual(4)
    for (let i = 0; i < 100 && h.sim.gravity.count > 0; i++) h.sim.step()
    expect(h.sim.store.getVoxel(10, 4, 10)).toBe(B.sand)
    expect(column().some(Boolean)).toBe(false)
  })

  it('is false outside the world, even beside units at its edges', () => {
    const h = make()
    for (const p of [[0, 4, 5], [31, 4, 5], [0, 4, 0], [31, 4, 31], [5, 4, 0], [5, 4, 31]] as Vec3[]) h.cmd({ type: 'unitSpawn', pos: p })
    for (const p of OUTSIDE) expect(h.inRule(ctx => ctx.occupied(...p)), `[${p}]`).toBe(false)
  })

  it('lets a rule stamp a tree all-or-nothing around a standing unit, and once it walked away', () => {
    // logs at (5, 4..6, 5), leaves around the crown; the unit at (6, 4, 5) has its head in the leaf cell (6, 5, 5)
    const tree: [Vec3, number][] = [
      [[5, 4, 5], B.log], [[5, 5, 5], B.log], [[5, 6, 5], B.log], [[5, 7, 5], B.leaves],
      [[4, 5, 5], B.leaves], [[6, 5, 5], B.leaves], [[4, 6, 5], B.leaves], [[6, 6, 5], B.leaves],
    ]
    const rules = defineRules({
      blocks: {
        sapling: {
          onScheduledTick(ctx, x, y, z) {
            const cells = tree.map(([[dx, dy, dz], v]) => [x + dx - 5, y + dy - 4, z + dz - 5, v] as const)
            const fits = cells.every(([cx, cy, cz]) => cx >= 0 && cy >= 0 && cz >= 0 && cx < ctx.size[0] && cy < ctx.size[1] && cz < ctx.size[2])
            if (!fits || cells.some(([cx, cy, cz]) => ctx.occupied(cx, cy, cz))) { ctx.emit('blocked'); ctx.schedule(x, y, z, 5); return }
            for (const [cx, cy, cz, v] of cells) ctx.set(cx, cy, cz, v)
            ctx.emit('grown')
          },
        },
      },
      commands: { plant: (ctx) => { ctx.set(5, 4, 5, ctx.id('sapling')); ctx.schedule(5, 4, 5, 1) } },
    })
    const h = make(rules)
    h.cmd({ type: 'unitSpawn', pos: [6, 4, 5] })
    const unit = h.sim.workers!.units.size
    const events: string[] = []
    const step = () => { for (const e of h.sim.step().events) events.push(e.type) }
    for (const e of h.cmd({ type: 'plant' }).events) events.push(e.type)
    for (let i = 0; i < 20; i++) step()
    expect(events).toContain('blocked')
    expect(events).not.toContain('grown')
    expect(h.sim.store.getVoxel(5, 4, 5)).toBe(B.sapling)
    expect(h.sim.store.getVoxel(6, 5, 5)).toBe(B.air)
    expect(h.sim.store.getVoxel(5, 5, 5)).toBe(B.air)
    expect(h.sim.workers!.view(unit)!.state).not.toBe('incapacitated')

    h.cmd({ type: 'unitMove', ids: [unit], pos: [12, 4, 12] })
    for (let i = 0; i < 300 && !events.includes('grown'); i++) step()
    expect(events).toContain('grown')
    for (const [[x, y, z], v] of tree) expect(h.sim.store.getVoxel(x, y, z), `[${x},${y},${z}]`).toBe(v)
    expect(h.sim.workers!.view(unit)!.state).not.toBe('incapacitated')
  })
})

describe('system context', () => {
  it('sees units the same way, and nothing outside the world', () => {
    let script: ((c: SystemContext) => void) | null = null
    const sys: GameSystem = { name: 'test', version: 1, snapshot: () => null, tick: c => { const s = script; script = null; s?.(c) } }
    const h = make({}, [32, 32, 32], [sys])
    const id = (() => { let out = 0; script = c => { out = c.units.spawn([5, 4, 5]) }; h.sim.step(); return out })()
    expect(id).toBeGreaterThan(0)
    const at = (p: Vec3) => { let out = false; script = c => { out = c.occupied(...p) }; h.sim.step(); return out }
    expect(at([5, 4, 5])).toBe(true)
    expect(at([5, 5, 5])).toBe(true)
    expect(at([6, 4, 5])).toBe(false)
    expect(at([5, 6, 5])).toBe(false)
    for (const p of OUTSIDE) expect(at(p), `[${p}]`).toBe(false)
  })

  it('sees a falling block during its fall', () => {
    let script: ((c: SystemContext) => void) | null = null
    const sys: GameSystem = { name: 'test', version: 1, snapshot: () => null, tick: c => { const s = script; script = null; s?.(c) } }
    const h = make({}, [32, 32, 32], [sys])
    h.cmd({ type: 'setBlock', pos: [10, 20, 10], voxel: B.sand })
    expect(h.sim.gravity.count).toBe(1)
    let column: boolean[] = []
    script = c => { column = Array.from({ length: 32 }, (_, y) => c.occupied(10, y, 10)) }
    h.sim.step()
    expect(column.some(Boolean)).toBe(true)
  })
})
