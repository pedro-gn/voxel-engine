import { afterEach, describe, expect, it } from 'vitest'
import type { FromSim } from '../src/protocol.ts'
import { defineGenerator } from '../src/sim/generator.ts'
import { columnsIn } from '../src/sim/simHost.ts'
import type { Simulation } from '../src/sim/simulation.ts'
import { AIR } from '../src/world/voxel.ts'
import { closePorts, genPorts, makeHost, waitFor } from './genHelpers.ts'
import { ID } from './helpers.ts'

afterEach(closePorts)

/** Flat stone ground `level` blocks high; a document without a numeric level is rejected. */
function levelGenerator(failColumn?: [number, number]) {
  let level = 0
  return defineGenerator({
    configure(doc) {
      const l = (doc as { level?: unknown }).level
      if (typeof l !== 'number') throw new Error('level must be a number')
      level = l
    },
    generateColumn(ctx, cx, cz) {
      if (failColumn && cx === failColumn[0] && cz === failColumn[1] && level === 50) throw new Error('cannot build 50')
      for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) for (let y = 0; y < level; y++) ctx.set(lx, y, lz, ID.stone)
    },
  })
}

const groundAt = (sim: Simulation, x: number, z: number) => {
  let y = 63
  while (y >= 0 && sim.store.getVoxel(x, y, z) === AIR) y--
  return y + 1
}
const answer = (out: FromSim[], type: 'terrain' | 'regenerated', id: number) =>
  out.find((m) => m.type === type && m.id === id) as Extract<FromSim, { type: 'terrain' | 'regenerated' }> | undefined

describe('columnsIn', () => {
  it('lists the chunk columns a block rectangle overlaps', () => {
    expect(columnsIn({ x0: 40, z0: 0, x1: 50, z1: 10 })).toEqual([[1, 0]])
    expect(columnsIn({ x0: 31, z0: 31, x1: 33, z1: 33 })).toEqual([[0, 0], [1, 0], [0, 1], [1, 1]])
  })
})

describe('SimHost regeneration (serial)', () => {
  it('regenerates only the chunk columns under the rectangle, with the new document', () => {
    const { host, out } = makeHost(levelGenerator(), { terrain: { level: 20 } })
    host.handle({ type: 'setTerrain', id: 1, doc: { level: 30 } })
    expect(answer(out, 'terrain', 1)).toEqual({ type: 'terrain', id: 1, ok: true })
    host.handle({ type: 'regenerate', id: 2, rect: { x0: 40, z0: 0, x1: 50, z1: 10 } })
    const r = answer(out, 'regenerated', 2)
    expect(r?.ok).toBe(true)
    const sim = host.simulation!
    expect(groundAt(sim, 32, 0)).toBe(30)
    expect(groundAt(sim, 63, 31)).toBe(30)
    expect(groundAt(sim, 64, 0)).toBe(20)
    expect(groundAt(sim, 40, 32)).toBe(20)
    expect(r?.type === 'regenerated' && r.ok && r.dirtyChunks.length).toBeGreaterThan(0)
  })

  it('leaves the world identical when regenerating with the same document', () => {
    const { host } = makeHost(levelGenerator(), { terrain: { level: 20 } })
    const before = host.simulation!.hash()
    host.handle({ type: 'regenerate', id: 1, rect: { x0: 0, z0: 0, x1: 96, z1: 64 } })
    expect(host.simulation!.hash()).toBe(before)
  })

  it('rejects an invalid document and keeps using the old one', () => {
    const { host, out } = makeHost(levelGenerator(), { terrain: { level: 20 } })
    host.handle({ type: 'setTerrain', id: 1, doc: { level: 'high' } })
    expect(answer(out, 'terrain', 1)).toEqual({ type: 'terrain', id: 1, ok: false, message: 'Error: level must be a number' })
    host.handle({ type: 'regenerate', id: 2, rect: { x0: 0, z0: 0, x1: 32, z1: 32 } })
    expect(groundAt(host.simulation!, 5, 5)).toBe(20)
  })

  it('reports a column that fails and leaves the area untouched', () => {
    const { host, out } = makeHost(levelGenerator([1, 0]), { terrain: { level: 20 } })
    host.handle({ type: 'setTerrain', id: 1, doc: { level: 50 } })
    host.handle({ type: 'regenerate', id: 2, rect: { x0: 0, z0: 0, x1: 64, z1: 32 } })
    expect(answer(out, 'regenerated', 2)).toEqual({ type: 'regenerated', id: 2, ok: false, message: 'Error: cannot build 50' })
    expect(groundAt(host.simulation!, 5, 5)).toBe(20)
  })

  it('marks the changed chunks and the neighbours that see their borders dirty, nothing else', () => {
    const { host, out } = makeHost(levelGenerator(), { terrain: { level: 20 } })
    host.handle({ type: 'setTerrain', id: 1, doc: { level: 30 } })
    host.handle({ type: 'regenerate', id: 2, rect: { x0: 32, z0: 0, x1: 64, z1: 32 } })
    const r = answer(out, 'regenerated', 2)
    if (!r || r.type !== 'regenerated' || !r.ok) throw new Error('regeneration failed')
    const L = host.simulation!.layout
    // Ground 20 → 30 in column (1, 0) stays inside chunk row cy 0; the row above does not change.
    const expected = [[1, 0], [0, 0], [2, 0], [0, 1], [1, 1], [2, 1]].map(([cx, cz]) => L.chunkIndex(cx!, 0, cz!))
    expect(r.dirtyChunks).toEqual(expected.sort((a, b) => a - b))
  })

  it('reports no dirty chunks when the area did not change', () => {
    const { host, out } = makeHost(levelGenerator(), { terrain: { level: 20 } })
    host.handle({ type: 'regenerate', id: 1, rect: { x0: 0, z0: 0, x1: 96, z1: 64 } })
    expect(answer(out, 'regenerated', 1)).toMatchObject({ ok: true, dirtyChunks: [] })
  })

  it('rejects a rectangle outside the world', () => {
    const { host, out } = makeHost(levelGenerator(), { terrain: { level: 20 } })
    host.handle({ type: 'regenerate', id: 1, rect: { x0: 0, z0: 0, x1: 97, z1: 10 } })
    expect(answer(out, 'regenerated', 1)).toEqual({ type: 'regenerated', id: 1, ok: false, message: 'rect must be integers with 0 <= x0 < x1 <= 96 and 0 <= z0 < z1 <= 64' })
  })
})

describe('SimHost regeneration (generation workers)', () => {
  async function pooled(workers = 2) {
    const gen = levelGenerator()
    const h = makeHost(gen, { terrain: { level: 20 }, genPorts: genPorts(workers, gen) })
    await waitFor(h.out, (m) => m.type === 'ready')
    return h
  }

  it('matches serial regeneration', async () => {
    const { host, out } = await pooled()
    host.handle({ type: 'setTerrain', id: 1, doc: { level: 26 } })
    host.handle({ type: 'regenerate', id: 2, rect: { x0: 10, z0: 10, x1: 70, z1: 40 } })
    await waitFor(out, (m) => m.type === 'regenerated')
    const serial = makeHost(levelGenerator(), { terrain: { level: 20 } })
    serial.host.handle({ type: 'setTerrain', id: 1, doc: { level: 26 } })
    serial.host.handle({ type: 'regenerate', id: 2, rect: { x0: 10, z0: 10, x1: 70, z1: 40 } })
    expect(host.simulation!.hash()).toBe(serial.host.simulation!.hash())
  })

  it('runs queued requests in order', async () => {
    const { host, out } = await pooled()
    host.handle({ type: 'setTerrain', id: 1, doc: { level: 25 } })
    host.handle({ type: 'regenerate', id: 2, rect: { x0: 0, z0: 0, x1: 32, z1: 32 } })
    host.handle({ type: 'regenerate', id: 3, rect: { x0: 64, z0: 32, x1: 96, z1: 64 } })
    await waitFor(out, (m) => m.type === 'regenerated' && m.id === 3)
    expect(out.filter((m) => m.type === 'regenerated').map((m) => m.type === 'regenerated' && m.id)).toEqual([2, 3])
    expect(groundAt(host.simulation!, 70, 40)).toBe(25)
  })

  it('reruns an in-flight request with a newer document', async () => {
    const { host, out } = await pooled()
    host.handle({ type: 'setTerrain', id: 1, doc: { level: 25 } })
    host.handle({ type: 'regenerate', id: 2, rect: { x0: 0, z0: 0, x1: 96, z1: 64 } })
    host.handle({ type: 'setTerrain', id: 3, doc: { level: 33 } })
    await waitFor(out, (m) => m.type === 'regenerated')
    expect(out.filter((m) => m.type === 'regenerated')).toHaveLength(1)
    expect(groundAt(host.simulation!, 50, 50)).toBe(33)
  })

  it('fails the active request when a worker dies, then falls back to serial generation', async () => {
    const { host, out } = await pooled(1)
    host.handle({ type: 'setTerrain', id: 1, doc: { level: 28 } })
    host.handle({ type: 'regenerate', id: 2, rect: { x0: 0, z0: 0, x1: 96, z1: 64 } })
    host.handle({ type: 'genLost', index: 0 })
    expect(answer(out, 'regenerated', 2)).toEqual({ type: 'regenerated', id: 2, ok: false, message: 'a generation worker stopped' })
    host.handle({ type: 'regenerate', id: 3, rect: { x0: 0, z0: 0, x1: 32, z1: 32 } })
    expect(answer(out, 'regenerated', 3)?.ok).toBe(true) // synchronous: no workers left
    expect(groundAt(host.simulation!, 5, 5)).toBe(28)
  })
})
