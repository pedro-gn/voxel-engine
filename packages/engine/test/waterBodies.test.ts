import { describe, expect, it } from 'vitest'
import { HEAD_EPS, SUB } from '../src/sim/water/constants.ts'
import { AIR, STONE, layered, wv } from './layerHelpers.ts'

/**
 * A lake (x 1–20, z 1–10, floor 10, water to y 19: surface 20) beside a hill (x 21–40, solid to y 24) pierced by a tunnel
 * (cells y 12–13, z 5–6) that ends in a shaft (x 41–42, z 5–6, open to the sky). Stone everywhere else up to y 24.
 * `tunnel`: the tunnel cells start full of water; `shaftTop`: water in the shaft up to that y (inclusive), −1 for none.
 */
function uTube(tunnel: boolean, shaftTop = -1) {
  return (x: number, y: number, z: number) => {
    if (y < 10) return STONE
    const lake = x >= 1 && x <= 20 && z >= 1 && z <= 10
    if (lake) return y <= 19 ? wv(7) : AIR
    const tube = z >= 5 && z <= 6 && y >= 12 && y <= 13 && x >= 21 && x <= 40
    if (tube) return tunnel ? wv(7) : AIR
    const shaft = z >= 5 && z <= 6 && x >= 41 && x <= 42 && y >= 12
    if (shaft) return y <= shaftTop ? wv(7) : AIR
    return y <= 24 ? STONE : AIR
  }
}

describe('pressurized bodies', () => {
  it('communicating vessels: the shaft rises to the lake level through a full tunnel, sways and settles (U-tube)', () => {
    const w = layered(uTube(false), [64, 32, 32])
    const total = w.total()
    let peak = 0
    w.settle(60_000, 1 << 20, () => { peak = Math.max(peak, w.cols.surface(41 + 5 * 64)) })
    const lake = w.cols.surface(10 + 5 * 64), shaft = w.cols.surface(41 + 5 * 64)
    expect(shaft).toBeGreaterThan(14 * SUB) // above the tunnel's roof: pressure lifted it
    expect(Math.abs(shaft - lake)).toBeLessThanOrEqual(2 * HEAD_EPS)
    expect(w.bodies.list.length).toBeGreaterThanOrEqual(1)
    expect(w.total()).toBe(total)
  })

  it('a hole under a solid top drains the lake to the hole floor (the 3c checkpoint case)', () => {
    // dam at x = 21 solid to y 24 but a hole at y 10–11, z 5–6; a valley floor at y 2 beyond it, walled at its far end
    const w = layered((x, y, z) => {
      if (y < 2) return STONE
      if (x >= 1 && x <= 20 && z >= 1 && z <= 10) return y < 10 ? STONE : y <= 19 ? wv(7) : AIR
      if (x === 21) return (z === 5 || z === 6) && (y === 10 || y === 11) ? AIR : y <= 24 ? STONE : AIR
      if (x >= 22 && x <= 62 && z >= 1 && z <= 10) return AIR
      return y <= 24 ? STONE : AIR
    }, [64, 32, 32])
    const total = w.total()
    w.settle(120_000)
    let lake = 0
    for (let z = 1; z <= 10; z++) for (let x = 1; x <= 20; x++) lake += w.cols.depth[x + z * 64]!
    expect(lake).toBeLessThan(200 * 2 * SUB) // from 10 blocks deep to the hole's floor (films and a level at the hole's top row aside)
    expect(w.total()).toBe(total)
  })

  it('a sealed full chamber is a body that never moves and costs no step', () => {
    const w = layered((x, y, z) => (y >= 4 && y <= 6 && x >= 3 && x <= 8 && z >= 3 && z <= 8 ? wv(7) : STONE))
    const total = w.total()
    w.settle(50) // the first step groups the body; nothing moves after
    expect(w.bodies.list.length).toBe(1)
    expect(w.bodies.list[0]!.bTile.length).toBe(0)
    expect(w.total()).toBe(total)
    expect(w.segs(5, 5)[0]).toEqual({ floor: 4, ceil: 7, depth: 3 * SUB })
  })

  it('a body draining from below frees its members from the top, each at most once (no flicker)', () => {
    // a full 6 × 6 × 4 tank (cells y 10–13) under a roof, with a one-column drain at its floor into a deep open pit
    const w = layered((x, y, z) => {
      if (y < 2) return STONE
      const tank = x >= 3 && x <= 8 && z >= 3 && z <= 8 && y >= 10 && y <= 13
      if (tank) return wv(7)
      if (x === 9 && z === 5 && y === 10) return AIR // the drain's opening, at the tank's floor
      if (x >= 10 && x <= 20 && z >= 3 && z <= 8 && y >= 2) return AIR // the pit, open to the sky
      return y <= 16 ? STONE : AIR
    })
    const total = w.total()
    const transitions = new Map<number, number>(), was = new Map<number, boolean>()
    w.settle(60_000, 1 << 20, () => {
      for (let i = 0; i < w.under.col.length; i++) {
        if (w.under.col[i]! < 0) continue
        const inBody = w.under.body[i]! >= 0
        if (was.has(i) && was.get(i) !== inBody) transitions.set(i, (transitions.get(i) ?? 0) + 1)
        was.set(i, inBody)
      }
    })
    for (const n of transitions.values()) expect(n).toBeLessThanOrEqual(2)
    expect(w.total()).toBe(total)
  })

  it('excess pushed into a body leaves through its boundary within a few steps, volume exact', () => {
    const w = layered(uTube(true, 19), [64, 32, 32])
    w.settle(60_000)
    const total = w.total()
    const i = w.under.first[30 + 5 * 64]!
    expect(w.under.body[i]).toBeGreaterThanOrEqual(0)
    w.under.excess[i] = SUB
    w.bodies.seed(i)
    w.wakeWet()
    const shaft0 = w.cols.surface(41 + 5 * 64)
    for (let k = 0; k < 40; k++) w.step()
    expect(w.bodies.list.every((b) => b.excess === 0)).toBe(true)
    expect(w.total()).toBe(total + SUB)
    expect(w.cols.surface(41 + 5 * 64)).toBeGreaterThanOrEqual(shaft0)
  })

  it('a body woken on one side wakes the far side: raising the lake lifts the sleeping shaft (Review Focus 2)', () => {
    const w = layered(uTube(true, 19), [64, 32, 32])
    w.settle(60_000)
    expect(w.cols.tiles.awakeCount()).toBe(0)
    const shaftTile = w.cols.tiles.of(41, 5)
    const s0 = w.cols.surface(41 + 5 * 64)
    for (let z = 1; z <= 10; z++) for (let x = 1; x <= 20; x++) w.cols.depth[x + z * 64] = w.cols.depth[x + z * 64]! + SUB / 2
    w.cols.tiles.wake(w.cols.tiles.of(20, 5)) // the lake tile holding the boundary edge (the lake spans tiles 0 and 1)
    let woke = false
    for (let k = 0; k < 200; k++) { w.step(); if (w.cols.tiles.awake[shaftTile] === 1) woke = true }
    expect(woke).toBe(true)
    expect(w.cols.surface(41 + 5 * 64)).toBeGreaterThan(s0)
  })
})
