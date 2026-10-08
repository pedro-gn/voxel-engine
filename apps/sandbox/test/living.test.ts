import { Simulation } from '@elovox/engine/src/sim/simulation.ts'
import { createWorldBuffers } from '@elovox/engine/src/world/buffers.ts'
import { AIR, packVoxel, voxelId } from '@elovox/engine/src/world/voxel.ts'
import type { Command } from '@elovox/engine'
import { describe, expect, it } from 'vitest'
import { BLOCKS } from '../src/blocks.ts'
import rules from '../src/rules.ts'
import {
  BRIDGE, CREWS, LIVING_WORKER_OPTIONS, SITE_HALF, TOWER_BASE, TUNNEL, UNITS, WALL,
  breachCommands, clearCommands, collapseCommands, moveGroupCommands, reservoirCommands, reservoirInterior,
  spawnCommands, towerCommands, workCommands, workSiteCommands, type Ids, type Site,
} from '../src/scenes/living.ts'
import { createLiving, submitAll } from '../src/livingScript.ts'

// A flat 64³ test world: stone below y 7, grass at y 7, so the first air is y 8.
const G = 8
const SITE: Site = { x: 32, z: 32, ground: G }
function world(extra?: (set: (x: number, y: number, z: number, v: number) => void, id: (n: string) => number) => void) {
  const sim = new Simulation({ buffers: createWorldBuffers([64, 64, 64]), blocks: BLOCKS, rules, seed: 1, randomTicksPerChunk: 0, workers: LIVING_WORKER_OPTIONS, log: () => {} })
  sim.generate({ generateColumn(ctx, cx, cz) {
    const stone = ctx.id('stone'), grass = ctx.id('grass')
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) for (let y = 0; y < G; y++) ctx.set(x, y, z, y === G - 1 ? grass : stone)
    extra?.((x, y, z, v) => { const lx = x - cx * 32, lz = z - cz * 32; if (lx >= 0 && lx < 32 && lz >= 0 && lz < 32) ctx.set(lx, y, lz, v) }, ctx.id)
  } })
  return sim
}
function ids(sim: Simulation): Ids {
  const r = sim.registry
  return { water: packVoxel(r.id('water'), 7), stone: r.id('stone'), planks: r.id('planks'), beam: r.id('structural_planks'), glass: r.id('structural_glass') }
}
let seq = 0
function run(sim: Simulation, commands: Command[]) {
  for (const c of commands) sim.submit(0, ++seq, c)
  const r = sim.step()
  for (const a of r.acks) expect(a.ok, a.error).toBe(true)
}
const at = (sim: Simulation, x: number, y: number, z: number) => voxelId(sim.store.getVoxel(x, y, z))

describe('living set pieces: command shapes', () => {
  it('keeps every box inside its site footprint', () => {
    const I: Ids = { water: 1, stone: 2, planks: 3, beam: 4, glass: 5 }
    const all = [...clearCommands(SITE), ...reservoirCommands(SITE, I), ...towerCommands(SITE, I), ...workSiteCommands(SITE, I), ...workCommands(SITE, I)]
    for (const c of all) {
      if (c.type !== 'fillRegion' && c.type !== 'workDig' && c.type !== 'workBuild') continue
      const b = c as unknown as { min: number[]; max: number[] }
      expect(b.min[0]).toBeGreaterThanOrEqual(SITE.x - SITE_HALF); expect(b.max[0]).toBeLessThan(SITE.x + SITE_HALF)
      expect(b.min[2]).toBeGreaterThanOrEqual(SITE.z - SITE_HALF); expect(b.max[2]).toBeLessThan(SITE.z + SITE_HALF)
    }
  })
  it('spawns 50 units, assigns the crews by id and moves only the group', () => {
    const I: Ids = { water: 1, stone: 2, planks: 3, beam: 4, glass: 5 }
    expect(spawnCommands(SITE, I).filter(c => c.type === 'unitSpawn')).toHaveLength(UNITS)
    expect([...CREWS.tunnel, ...CREWS.bridge, ...CREWS.wall, ...CREWS.group].sort((a, b) => a - b)).toEqual(Array.from({ length: UNITS }, (_, i) => i + 1))
    expect(moveGroupCommands(SITE)).toEqual([{ type: 'unitMove', ids: [...CREWS.group], pos: [SITE.x, SITE.ground, SITE.z] }])
    const work = workCommands(SITE, I)
    expect(work.map(c => c.type)).toEqual(['workDig', 'workBuild', 'workBuild'])
    expect(work.map(c => (c as { ids?: number[] }).ids)).toEqual([[...CREWS.tunnel], [...CREWS.bridge], [...CREWS.wall]])
  })
})

describe('living set pieces: simulation', () => {
  it('clears a tree off the site, and the reservoir holds until the breach pours it out', () => {
    const sim = world((set, id) => { for (let y = G; y < G + 6; y++) set(SITE.x - 10, y, SITE.z - 10, id('log')) })
    const I = ids(sim)
    run(sim, [...clearCommands(SITE), ...reservoirCommands(SITE, I)])
    expect(at(sim, SITE.x - 10, G + 3, SITE.z - 10)).not.toBe(sim.registry.id('log'))
    const inside = reservoirInterior(SITE), water = sim.registry.id('water')
    for (let t = 0; t < 200; t++) sim.step()
    expect(at(sim, inside.min[0] + 5, inside.min[1], inside.min[2] + 5)).toBe(water)
    const outsideEast = () => { let n = 0; for (let x = inside.max[0] + 2; x < SITE.x + SITE_HALF; x++) for (let z = inside.min[2]; z <= inside.max[2]; z++) if (at(sim, x, G, z) === water) n++; return n }
    expect(outsideEast()).toBe(0)
    run(sim, breachCommands(SITE))
    for (let t = 0; t < 200; t++) sim.step()
    expect(outsideEast()).toBeGreaterThan(0)
  }, 120_000)

  it('the tower stands on its plinth and falls when the plinth is cut', () => {
    const sim = world(), I = ids(sim)
    run(sim, [...clearCommands(SITE), ...towerCommands(SITE, I)])
    const base = TOWER_BASE(SITE), corner: [number, number, number] = [base.min[0], base.max[1] + 1, base.min[2]]
    expect(at(sim, ...corner)).toBe(I.beam)
    for (let t = 0; t < 40; t++) sim.step()
    expect(at(sim, ...corner)).toBe(I.beam)
    run(sim, collapseCommands(SITE))
    let landed = false
    for (let t = 0; t < 600 && !landed; t++) { sim.step(); landed = at(sim, base.min[0], G, base.min[2]) === I.beam }
    expect(landed).toBe(true)
  }, 120_000)

  it('50 units spawn on the cleared site, and every crew makes progress', () => {
    const sim = world((set, id) => { for (let y = G; y < G + 6; y++) set(SITE.x + 4, y, SITE.z + 8, id('log')) })
    const I = ids(sim)
    run(sim, [...clearCommands(SITE), ...workSiteCommands(SITE, I)])
    run(sim, spawnCommands(SITE, I))
    expect(sim.workers!.units.size).toBe(UNITS)
    run(sim, workCommands(SITE, I))
    const t = TUNNEL(SITE), b = BRIDGE(SITE), w = WALL(SITE)
    const dug = () => at(sim, t.min[0], t.min[1], t.min[2]) === AIR || at(sim, t.max[0], t.min[1], t.min[2]) === AIR
    const bridged = () => at(sim, b.min[0], b.min[1], b.min[2]) === I.planks || at(sim, b.max[0], b.min[1], b.min[2]) === I.planks
    const walled = () => at(sim, w.min[0], w.min[1], w.min[2]) === I.stone || at(sim, w.max[0], w.min[1], w.min[2]) === I.stone
    for (let i = 0; i < 2000 && !(dug() && bridged() && walled()); i++) sim.step()
    expect({ dug: dug(), bridged: bridged(), walled: walled() }).toEqual({ dug: true, bridged: true, walled: true })
  }, 180_000)
})

describe('submitAll', () => {
  function fakeEngine(fail?: number) {
    const listeners = new Set<(a: { seq: number; ok: boolean; error?: string; clientId: number }) => void>()
    let seq = 0
    return {
      submit: () => { const s = ++seq; queueMicrotask(() => { for (const l of listeners) l({ clientId: 0, seq: s, ok: s !== fail, ...(s === fail && { error: 'spawn needs clear body, safe water and support' }) }) }); return s },
      on: (_type: string, fn: (a: { seq: number; ok: boolean; error?: string; clientId: number }) => void) => { listeners.add(fn); return () => listeners.delete(fn) },
    }
  }
  it('resolves once every command is acked', async () => {
    await expect(submitAll(fakeEngine() as never, [{ type: 'setBlock', pos: [0, 0, 0], voxel: 0 }, { type: 'setBlock', pos: [1, 0, 0], voxel: 0 }])).resolves.toBeUndefined()
  })
  it('rejects with the first refused command instead of hanging', async () => {
    await expect(submitAll(fakeEngine(2) as never, [{ type: 'setBlock', pos: [0, 0, 0], voxel: 0 }, { type: 'setBlock', pos: [1, 0, 0], voxel: 0 }])).rejects.toThrow('spawn needs clear body')
  })
})

describe('living script', () => {
  it('starting work twice queues the orders once', async () => {
    const submitted: Command[] = []
    let seq = 0
    const listeners = new Set<(a: { seq: number; ok: boolean; clientId: number }) => void>()
    const engine = {
      blocks: { id: (n: string) => ({ water: 1, stone: 2, planks: 3, structural_planks: 4, structural_glass: 5 } as Record<string, number>)[n]! },
      submit: (c: Command) => { submitted.push(c); const s = ++seq; queueMicrotask(() => { for (const l of listeners) l({ clientId: 0, seq: s, ok: true }) }); return s },
      on: (_t: string, fn: (a: { seq: number; ok: boolean; clientId: number }) => void) => { listeners.add(fn); return () => listeners.delete(fn) },
    }
    const living = createLiving(engine as never)
    await Promise.all([living.startWork(), living.startWork()])
    expect(submitted.filter(c => c.type === 'workDig')).toHaveLength(1)
  })
})
