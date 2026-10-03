import { afterEach, describe, expect, it } from 'vitest'
import { GenHost } from '../src/gen/genHost.ts'
import type { FromGen, FromSim } from '../src/protocol.ts'
import { defineGenerator } from '../src/sim/generator.ts'
import type { Simulation } from '../src/sim/simulation.ts'
import { AIR } from '../src/world/voxel.ts'
import { closePorts, genPorts, makeHost, waitFor } from './genHelpers.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'

afterEach(closePorts)

/**
 * Flat stone `level` blocks high. A patch { level } sets the level (idempotent: in tests the sim and
 * every "worker" share this one object). `refuse(call)` makes a patch call throw.
 */
function patchable(refuse: (call: number) => boolean = () => false) {
  let level = 0, calls = 0
  return defineGenerator({
    configure(doc) { level = (doc as { level: number }).level },
    patch(p) {
      calls++
      const l = (p as { level?: unknown }).level
      if (typeof l !== 'number') throw new Error('level must be a number')
      if (refuse(calls)) throw new Error('diverged')
      level = l
    },
    generateColumn(ctx) {
      for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) for (let y = 0; y < level; y++) ctx.set(lx, y, lz, ID.stone)
    },
  })
}

const groundAt = (sim: Simulation, x: number, z: number) => {
  let y = 63
  while (y >= 0 && sim.store.getVoxel(x, y, z) === AIR) y--
  return y + 1
}
const answer = (out: FromSim[], id: number) => out.find((m) => m.type === 'terrain' && m.id === id)
const WHOLE = { x0: 0, z0: 0, x1: 96, z1: 64 }

describe('SimHost terrain patches (serial)', () => {
  it('applies a patch to the generator; the next regeneration uses it', () => {
    const { host, out } = makeHost(patchable(), { terrain: { level: 20 } })
    host.handle({ type: 'patchTerrain', id: 1, patch: { level: 27 } })
    expect(answer(out, 1)).toEqual({ type: 'terrain', id: 1, ok: true })
    host.handle({ type: 'regenerate', id: 2, rect: { x0: 0, z0: 0, x1: 32, z1: 32 } })
    expect(groundAt(host.simulation!, 5, 5)).toBe(27)
    expect(groundAt(host.simulation!, 40, 5)).toBe(20)
  })

  it('answers a refused patch with its message and changes nothing', () => {
    const { host, out } = makeHost(patchable(), { terrain: { level: 20 } })
    host.handle({ type: 'patchTerrain', id: 1, patch: { level: 'x' } })
    expect(answer(out, 1)).toEqual({ type: 'terrain', id: 1, ok: false, message: 'Error: level must be a number' })
    host.handle({ type: 'regenerate', id: 2, rect: WHOLE })
    expect(groundAt(host.simulation!, 5, 5)).toBe(20)
  })

  it('refuses patches when the generator has none', () => {
    const { host, out } = makeHost(defineGenerator({ generateColumn() {} }))
    host.handle({ type: 'patchTerrain', id: 1, patch: {} })
    expect(answer(out, 1)).toEqual({ type: 'terrain', id: 1, ok: false, message: 'the generator does not support patches' })
  })
})

describe('SimHost terrain patches (generation workers)', () => {
  async function pooled(gen = patchable(), workers = 2) {
    const h = makeHost(gen, { terrain: { level: 20 }, genPorts: genPorts(workers, gen) })
    await waitFor(h.out, (m) => m.type === 'ready')
    return h
  }

  it('refuses patches until the initial generation is in', async () => {
    const gen = patchable()
    const { host, out } = makeHost(gen, { terrain: { level: 20 }, genPorts: genPorts(2, gen) })
    host.handle({ type: 'patchTerrain', id: 1, patch: { level: 25 } })
    expect(answer(out, 1)).toEqual({ type: 'terrain', id: 1, ok: false, message: 'the world is still generating' })
    await waitFor(out, (m) => m.type === 'ready')
  })

  it('patches the workers too, matching serial regeneration', async () => {
    const { host, out } = await pooled()
    host.handle({ type: 'patchTerrain', id: 1, patch: { level: 26 } })
    host.handle({ type: 'regenerate', id: 2, rect: WHOLE })
    await waitFor(out, (m) => m.type === 'regenerated')
    expect(groundAt(host.simulation!, 70, 40)).toBe(26)
    const serial = makeHost(patchable(), { terrain: { level: 20 } })
    serial.host.handle({ type: 'patchTerrain', id: 1, patch: { level: 26 } })
    serial.host.handle({ type: 'regenerate', id: 2, rect: WHOLE })
    expect(host.simulation!.hash()).toBe(serial.host.simulation!.hash())
  })

  it('reruns an in-flight regeneration with the patched document', async () => {
    const { host, out } = await pooled()
    host.handle({ type: 'regenerate', id: 2, rect: WHOLE })
    host.handle({ type: 'patchTerrain', id: 3, patch: { level: 33 } })
    await waitFor(out, (m) => m.type === 'regenerated')
    expect(out.filter((m) => m.type === 'regenerated')).toHaveLength(1)
    expect(groundAt(host.simulation!, 50, 50)).toBe(33)
  })

  it('is fatal when a worker refuses a patch the sim accepted', async () => {
    const { host, out } = await pooled(patchable((call) => call > 1), 1) // call 1: the sim; call 2: the worker
    host.handle({ type: 'patchTerrain', id: 1, patch: { level: 30 } })
    expect(answer(out, 1)).toEqual({ type: 'terrain', id: 1, ok: true })
    await waitFor(out, (m) => m.type === 'fatal')
    expect(out.at(-1)).toEqual({ type: 'fatal', message: 'Error: a generation worker refused a patch the sim accepted: Error: diverged' })
  })
})

describe('GenHost patches', () => {
  const configure = { type: 'configure', epoch: 1, doc: { level: 3 }, size: [64, 64, 64], seed: 5, blocks: TEST_BLOCKS } as const

  it('applies a patch and answers later jobs under its epoch', () => {
    const out: FromGen[] = []
    const host = new GenHost((m) => out.push(m), patchable())
    host.handle(configure)
    host.handle({ type: 'patch', epoch: 2, patch: { level: 4 } })
    host.handle({ type: 'job', id: 1, cx: 0, cz: 0 })
    const m = out[0]!
    expect(m.type === 'column' && [m.epoch, m.data[3 << 10], m.data[4 << 10]]).toEqual([2, ID.stone, 0])
  })

  it('reports a refused patch as fatal', () => {
    const out: FromGen[] = []
    const host = new GenHost((m) => out.push(m), patchable())
    host.handle(configure)
    host.handle({ type: 'patch', epoch: 2, patch: { level: 'x' } })
    expect(out).toEqual([{ type: 'fatal', epoch: 2, message: 'Error: level must be a number' }])
  })
})
