import { describe, expect, it } from 'vitest'
import type { Simulation } from '../src/sim/simulation.ts'
import { R, fullRestore, richScript, richSim } from './persistHelpers.ts'

function runTo(t: number): Simulation { const s = richSim(); for (let i = 0; i < t; i++) { richScript(s, i); s.step() } return s }
const units = (s: Simulation) => [...s.workers!.units.values()].map(u => ({ id: u.id, x: u.x, y: u.y, z: u.z, stock: [...u.stock], tools: [...u.tools] }))

describe('workers in a save', () => {
  it('keeps a unit walking on the flat where it stands, and puts a unit mid vertical step back where the step began', () => {
    const a = runTo(14)
    const seen = { flat: false, vertical: false }
    for (let t = 14; t < 300 && !(seen.flat && seen.vertical); t++) {
      const units = [...a.workers!.units.values()]
      const flat = units.find(u => u.motion?.flat), vertical = units.find(u => u.motion && !u.motion.flat)
      if ((flat && !seen.flat) || (vertical && !seen.vertical)) {
        const b = fullRestore(a)
        expect(b.workers!.units.size).toBe(a.workers!.units.size)
        for (const r of b.workers!.units.values()) expect(r.motion).toBeNull()
        if (flat && !seen.flat) { seen.flat = true; const r = b.workers!.units.get(flat.id)!; expect([r.x, r.y, r.z]).toEqual([flat.x, flat.y, flat.z]) }
        if (vertical && !seen.vertical) { seen.vertical = true; const r = b.workers!.units.get(vertical.id)!; expect([r.x, r.y, r.z]).toEqual(vertical.motion!.start) }
      }
      a.step()
    }
    expect(seen).toEqual({ flat: true, vertical: true })
  })
  it('finishes every order after a load, and keeps stock and piles', () => {
    const a = runTo(14)
    const stock = units(a).find(u => u.id === 1)!.stock
    const b = fullRestore(a)
    expect(units(b).find(u => u.id === 1)!.stock).toEqual(stock)
    expect(b.workers!.viewDrops()).toEqual(a.workers!.viewDrops())
    for (let i = 0; i < 4000 && b.workers!.busy; i++) b.step()
    const orders = b.workers!.publication().orders
    expect(orders.length).toBe(2)
    for (const o of orders) expect(o.done).toBe(o.total)
    for (let x = 48; x <= 50; x++) expect(b.store.getVoxel(x, 3, 49) & 0xfff).not.toBe(R.stone) // dug (the breached basin may have flooded it)
    expect(b.store.getVoxel(37, 4, 51) & 0xfff).toBe(R.planks)
  })
  it('two loads run identically and save → load → save is idempotent', () => {
    const a = runTo(14)
    const b = fullRestore(a), c = fullRestore(a)
    expect(b.workers!.snapshot()).toEqual(a.workers!.snapshot())
    for (let t = 0; t < 300; t++) { b.step(); c.step() }
    expect(b.hash()).toBe(c.hash())
    expect(units(b)).toEqual(units(c))
  })
  it('refuses to restore into a system that already has units', () => {
    const a = runTo(3)
    expect(() => a.workers!.restore(a.workers!.snapshot())).toThrow(/empty/)
  })
})
