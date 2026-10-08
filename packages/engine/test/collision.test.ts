import { describe, expect, it } from 'vitest'
import { BlockRegistry, defineBlock } from '../src/blocks/registry.ts'
import {
  CONTACT_EPS, bodyBox, boxOverlapsSolid, groundDistance, liquidAt, liquidInBox, moveBox, sweepBox, unstick,
  type Box, type CollisionWorld, type SweepResult,
} from '../src/interact/collision.ts'
import type { WorldSize } from '../src/world/layout.ts'
import { packVoxel } from '../src/world/voxel.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'

const REG = new BlockRegistry([...TEST_BLOCKS, defineBlock({ name: 'spring', textures: 'water', liquid: true, source: 'water' })])
const STONE = ID.stone, WATER = ID.water, SPRING = 8

function makeWorld(size: WorldSize = [64, 64, 64]) {
  const cells = new Map<number, number>()
  const key = (x: number, y: number, z: number) => x + z * size[0] + y * size[0] * size[2]
  const world: CollisionWorld = { size, get: (x, y, z) => cells.get(key(x, y, z)) ?? 0, solid: REG.solid, liquid: REG.liquid, source: REG.source }
  const set = (x: number, y: number, z: number, v: number) => { cells.set(key(x, y, z), v) }
  const fill = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, v: number) => {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) set(x, y, z, v)
  }
  return { world, set, fill }
}
/** The standard test body: 0.6 wide, 1.8 tall, feet centre (x, y, z). */
const body = (x: number, y: number, z: number): Box => bodyBox(x, y, z, 0.3, 1.8)

describe('bodyBox and boxOverlapsSolid', () => {
  it('builds a feet-centred box', () => {
    expect(bodyBox(10.5, 5, 10.5, 0.3, 1.8)).toEqual({ minX: 10.5 - 0.3, minY: 5, minZ: 10.5 - 0.3, maxX: 10.5 + 0.3, maxY: 5 + 1.8, maxZ: 10.5 + 0.3 })
  })
  it('overlaps a solid voxel inside the box, never a liquid one', () => {
    const { world, set } = makeWorld()
    set(10, 6, 10, WATER)
    expect(boxOverlapsSolid(world, body(10.5, 5, 10.5))).toBe(false)
    set(10, 6, 10, STONE)
    expect(boxOverlapsSolid(world, body(10.5, 5, 10.5))).toBe(true)
  })
  it('does not count touching faces or float residue as overlap', () => {
    const { world, set } = makeWorld()
    set(10, 4, 10, STONE); set(11, 5, 10, STONE)
    expect(boxOverlapsSolid(world, body(10.5, 5, 10.5))).toBe(false)
    expect(boxOverlapsSolid(world, body(10.5, 5 - 1e-9, 10.5))).toBe(false)
    expect(boxOverlapsSolid(world, body(10.7, 5, 10.5))).toBe(false)
    expect(boxOverlapsSolid(world, body(10.701, 5, 10.5))).toBe(true)
  })
  it('treats the sides and the floor as solid and above the top as air', () => {
    const { world } = makeWorld()
    expect(boxOverlapsSolid(world, body(0.2, 5, 10.5))).toBe(true)
    expect(boxOverlapsSolid(world, body(63.8, 5, 10.5))).toBe(true)
    expect(boxOverlapsSolid(world, body(10.5, 5, 0.2))).toBe(true)
    expect(boxOverlapsSolid(world, body(10.5, 5, 63.8))).toBe(true)
    expect(boxOverlapsSolid(world, body(10.5, -0.1, 10.5))).toBe(true)
    expect(boxOverlapsSolid(world, body(10.5, 0, 10.5))).toBe(false)
    expect(boxOverlapsSolid(world, body(10.5, 63, 10.5))).toBe(false)
    expect(boxOverlapsSolid(world, body(10.5, 1e9, 10.5))).toBe(false)
    expect(boxOverlapsSolid(world, body(63.8, 100, 10.5))).toBe(true)
  })
  it('a non-finite box overlaps nothing', () => {
    const { world } = makeWorld()
    expect(boxOverlapsSolid(world, body(NaN, 5, 10.5))).toBe(false)
    expect(boxOverlapsSolid(world, { ...body(10.5, 5, 10.5), maxY: Infinity })).toBe(false)
  })
})

/** The box after a result's displacement. */
const after = (b: Box, r: SweepResult): Box =>
  ({ minX: b.minX + r.dx, minY: b.minY + r.dy, minZ: b.minZ + r.dz, maxX: b.maxX + r.dx, maxY: b.maxY + r.dy, maxZ: b.maxZ + r.dz })

describe('sweepBox', () => {
  it('moves freely through air', () => {
    const { world } = makeWorld()
    expect(sweepBox(world, body(10.5, 10, 10.5), [1, 2, -0.5])).toEqual({ dx: 1, dy: 2, dz: -0.5, blockedX: false, blockedY: false, blockedZ: false })
  })
  it('stops each face exactly on the voxel plane', () => {
    const { world, set } = makeWorld()
    set(12, 10, 10, STONE); set(8, 10, 10, STONE); set(10, 10, 12, STONE); set(10, 10, 8, STONE)
    set(10, 13, 10, STONE); set(10, 4, 10, STONE)
    const b = body(10.5, 10, 10.5)
    const px = sweepBox(world, b, [5, 0, 0]); expect(b.maxX + px.dx).toBeCloseTo(12, 9); expect(px.blockedX).toBe(true)
    const nx = sweepBox(world, b, [-5, 0, 0]); expect(b.minX + nx.dx).toBeCloseTo(9, 9); expect(nx.blockedX).toBe(true)
    const pz = sweepBox(world, b, [0, 0, 5]); expect(b.maxZ + pz.dz).toBeCloseTo(12, 9); expect(pz.blockedZ).toBe(true)
    const nz = sweepBox(world, b, [0, 0, -5]); expect(b.minZ + nz.dz).toBeCloseTo(9, 9); expect(nz.blockedZ).toBe(true)
    const py = sweepBox(world, b, [0, 5, 0]); expect(b.maxY + py.dy).toBeCloseTo(13, 9); expect(py.blockedY).toBe(true)
    const ny = sweepBox(world, b, [0, -20, 0]); expect(b.minY + ny.dy).toBeCloseTo(5, 9); expect(ny.blockedY).toBe(true)
    for (const r of [px, nx, pz, nz, py, ny]) expect(boxOverlapsSolid(world, after(b, r))).toBe(false)
  })
  it('never tunnels through a one-voxel wall or floor, at any length', () => {
    const { world, fill } = makeWorld()
    fill(20, 0, 0, 20, 30, 30, STONE) // wall at x = 20
    fill(0, 3, 40, 30, 3, 60, STONE)  // floor at y = 3, under z 40..60
    for (const d of [0.9, 10, 1e4]) {
      const b = body(19.2, 10, 10.5) // maxX = 19.5
      const r = sweepBox(world, b, [d, 0, 0])
      expect(b.maxX + r.dx).toBeCloseTo(20, 9)
      expect(r.blockedX).toBe(true)
    }
    const fall = sweepBox(world, body(10.5, 50, 50.5), [0, -1e4, 0])
    expect(50 + fall.dy).toBeCloseTo(4, 9)
  })
  it('stops across a chunk border', () => {
    const { world, set } = makeWorld()
    set(32, 10, 10, STONE)
    const b = body(30.5, 10, 10.5)
    expect(b.maxX + sweepBox(world, b, [100, 0, 0]).dx).toBeCloseTo(32, 9)
  })
  it('stops at the world sides and floor, and lets the box rise above the top and come back', () => {
    const { world } = makeWorld()
    const b = body(2.5, 10, 2.5)
    expect(b.minX + sweepBox(world, b, [-100, 0, 0]).dx).toBeCloseTo(0, 9)
    expect(b.minZ + sweepBox(world, b, [0, 0, -100]).dz).toBeCloseTo(0, 9)
    const e = body(61.5, 10, 61.5)
    expect(e.maxX + sweepBox(world, e, [100, 0, 0]).dx).toBeCloseTo(64, 9)
    expect(e.maxZ + sweepBox(world, e, [0, 0, 100]).dz).toBeCloseTo(64, 9)
    expect(10 + sweepBox(world, b, [0, -100, 0]).dy).toBeCloseTo(0, 9)
    const up = sweepBox(world, body(10.5, 60, 10.5), [0, 100, 0])
    expect(up).toMatchObject({ dy: 100, blockedY: false })
    const back = sweepBox(world, body(10.5, 160, 10.5), [0, -200, 0])
    expect(160 + back.dy).toBeCloseTo(0, 9)
  })
  it('terminates on huge vertical displacements', () => {
    const { world } = makeWorld()
    expect(sweepBox(world, body(10.5, 10, 10.5), [0, 1e12, 0]).dy).toBe(1e12)
    expect(1e12 + sweepBox(world, body(10.5, 1e12, 10.5), [0, -2e12, 0]).dy).toBeCloseTo(0, 0)
  })
  it('slides along a wall when moving diagonally', () => {
    const { world, fill } = makeWorld()
    fill(12, 10, 0, 12, 11, 30, STONE)
    const r = sweepBox(world, body(10.5, 10, 10.5), [5, 0, 3])
    expect(10.8 + r.dx).toBeCloseTo(12, 9)
    expect(r).toMatchObject({ dz: 3, blockedX: true, blockedZ: false })
  })
  it('sweeps the larger horizontal axis first, x on a tie', () => {
    const { world, set } = makeWorld()
    set(12, 10, 12, STONE)
    const zFirst = sweepBox(world, body(10.5, 10, 10.5), [2, 0, 2.5])
    expect(zFirst.dz).toBe(2.5); expect(10.8 + zFirst.dx).toBeCloseTo(12, 9)
    const tie = sweepBox(world, body(10.5, 10, 10.5), [2, 0, 2])
    expect(tie.dx).toBe(2); expect(10.8 + tie.dz).toBeCloseTo(12, 9)
  })
  it('passes a gap exactly as wide as the box and stops at a narrower one', () => {
    const { world, fill } = makeWorld()
    fill(10, 10, 12, 10, 12, 30, STONE); fill(12, 10, 12, 12, 12, 30, STONE) // a corridor x in [11, 12) from z = 12
    expect(sweepBox(world, bodyBox(11.5, 10, 9.5, 0.5, 1.8), [0, 0, 10]).dz).toBe(10)
    const wide = bodyBox(11.5, 10, 9.5, 0.6, 1.8)
    expect(wide.maxZ + sweepBox(world, wide, [0, 0, 10]).dz).toBeCloseTo(12, 9)
  })
  it('slides on a floor it rests on with float residue', () => {
    const { world, fill, set } = makeWorld()
    fill(0, 4, 0, 30, 4, 30, STONE)
    expect(sweepBox(world, body(10.5, 5 - 1e-9, 10.5), [3, 0, 0])).toMatchObject({ dx: 3, blockedX: false })
    set(12, 5, 10, STONE)
    const touching = { ...body(10.5, 5, 10.5), minX: 11.4 + 5e-8, maxX: 12 + 5e-8 }
    expect(sweepBox(world, touching, [1, 0, 0])).toMatchObject({ dx: 0, blockedX: true })
    expect(sweepBox(world, touching, [-1, 0, 0])).toMatchObject({ dx: -1, blockedX: false })
  })
  it('never creeps into a wall through many tiny steps', () => {
    const { world, set } = makeWorld()
    set(12, 10, 10, STONE)
    let b: Box = { ...body(10.5, 10, 10.5), minX: 11.4, maxX: 12 }
    for (let i = 0; i < 1000; i++) b = after(b, sweepBox(world, b, [1e-8, 0, 0]))
    expect(b.maxX).toBeLessThan(12 + CONTACT_EPS)
    expect(sweepBox(world, b, [1, 0, 0]).dx).toBe(0)
  })
  it('lets a box escape a block edited into it, but never into new solid', () => {
    const { world, set } = makeWorld()
    set(10, 10, 10, STONE)
    const b = body(10.5, 10, 10.5)
    expect(sweepBox(world, b, [3, 0, 0]).dx).toBe(3)
    expect(sweepBox(world, b, [-3, 0, 0]).dx).toBe(-3)
    set(12, 10, 10, STONE); set(8, 10, 10, STONE)
    expect(10.8 + sweepBox(world, b, [3, 0, 0]).dx).toBeCloseTo(12, 9)
    expect(10.2 + sweepBox(world, b, [-3, 0, 0]).dx).toBeCloseTo(9, 9)
  })
  it('a degenerate box on a grid plane still stops and terminates', () => {
    const { world, set } = makeWorld()
    set(12, 10, 10, STONE)
    const flat: Box = { minX: 10, minY: 10, minZ: 10, maxX: 10, maxY: 10, maxZ: 10 }
    expect(10 + sweepBox(world, flat, [1e4, 0, 0]).dx).toBeCloseTo(12, 9)
    expect(sweepBox(world, flat, [0, 0, 1e4]).dz).toBeCloseTo(54, 9)
  })
  it('treats non-finite input as no motion', () => {
    const { world } = makeWorld()
    expect(sweepBox(world, body(10.5, 10, 10.5), [NaN, Infinity, 1])).toEqual({ dx: 0, dy: 0, dz: 1, blockedX: false, blockedY: false, blockedZ: false })
    expect(sweepBox(world, body(NaN, 10, 10.5), { x: 1, y: 1, z: 1 })).toEqual({ dx: 0, dy: 0, dz: 0, blockedX: false, blockedY: false, blockedZ: false })
  })
  it('fills and returns the out object', () => {
    const { world } = makeWorld()
    const out: SweepResult = { dx: 9, dy: 9, dz: 9, blockedX: true, blockedY: true, blockedZ: true }
    expect(sweepBox(world, body(10.5, 10, 10.5), [1, 0, 0], out)).toBe(out)
    expect(out).toEqual({ dx: 1, dy: 0, dz: 0, blockedX: false, blockedY: false, blockedZ: false })
  })
})

/** A stone floor whose top is y = 5 under x, z in [0, 31). */
function floored() {
  const t = makeWorld()
  t.fill(0, 4, 0, 30, 4, 30, STONE)
  return t
}

describe('groundDistance', () => {
  it('measures the drop to the support within maxDown', () => {
    const { world } = floored()
    expect(groundDistance(world, body(10.5, 5, 10.5))).toBe(0)
    expect(groundDistance(world, body(10.5, 5.0005, 10.5))).toBeCloseTo(0.0005, 9)
    expect(groundDistance(world, body(10.5, 5.5, 10.5))).toBeNull()
    expect(groundDistance(world, body(10.5, 5.5, 10.5), 1)).toBeCloseTo(0.5, 9)
    expect(groundDistance(world, body(40.5, 5, 40.5), 1)).toBeNull()
    expect(groundDistance(world, body(40.5, 0, 40.5))).toBe(0) // the world floor
    expect(groundDistance(world, body(10.5, 5.5, 10.5), NaN)).toBeNull() // falls back to GROUND_EPS
    expect(groundDistance(world, body(NaN, 5, 10.5))).toBeNull()
  })
})

describe('moveBox', () => {
  it('reports grounded, ceiling and blockedY', () => {
    const { world, set } = floored()
    const land = moveBox(world, body(10.5, 6, 10.5), [0, -2, 0])
    expect(land).toMatchObject({ blockedY: true, ceiling: false, grounded: true, stepped: 0 })
    expect(6 + land.dy).toBeCloseTo(5, 9)
    set(10, 8, 10, STONE)
    const bump = moveBox(world, body(10.5, 5, 10.5), [0, 2, 0])
    expect(bump).toMatchObject({ blockedY: true, ceiling: true, grounded: false })
    expect(6.8 + bump.dy).toBeCloseTo(8, 9)
    expect(moveBox(world, body(10.5, 5, 10.5), [1, 0, 0])).toMatchObject({ dx: 1, grounded: true, ceiling: false })
  })
  it('does not step without stepHeight', () => {
    const { world, fill } = floored()
    fill(12, 5, 0, 12, 5, 30, STONE)
    const r = moveBox(world, body(10.5, 5, 10.5), [2, -0.01, 0])
    expect(10.8 + r.dx).toBeCloseTo(12, 9)
    expect(r).toMatchObject({ blockedX: true, stepped: 0 })
  })
  it('climbs a one-block ledge with stepHeight 1 and 1.25', () => {
    const { world, fill } = floored()
    fill(12, 5, 0, 12, 5, 30, STONE)
    for (const stepHeight of [1, 1.25]) {
      const r = moveBox(world, body(10.5, 5, 10.5), [2, -0.01, 0], { stepHeight })
      expect(r).toMatchObject({ dx: 2, blockedX: false, grounded: true })
      expect(r.stepped).toBeCloseTo(1, 9)
      expect(r.dy).toBeCloseTo(1, 9)
      expect(boxOverlapsSolid(world, after(body(10.5, 5, 10.5), r))).toBe(false)
    }
  })
  it('refuses a ledge higher than stepHeight', () => {
    const { world, fill } = floored()
    fill(12, 5, 0, 12, 5, 30, STONE)
    expect(moveBox(world, body(10.5, 5, 10.5), [2, -0.01, 0], { stepHeight: 0.6 })).toMatchObject({ blockedX: true, stepped: 0, dy: 0 })
    fill(12, 6, 0, 12, 6, 30, STONE)
    expect(moveBox(world, body(10.5, 5, 10.5), [2, -0.01, 0], { stepHeight: 1 })).toMatchObject({ blockedX: true, stepped: 0, dy: 0 })
  })
  it('refuses a step with too little headroom, over the ledge or over the body', () => {
    const { world, fill } = floored()
    fill(12, 5, 0, 12, 5, 30, STONE)
    fill(12, 7, 0, 14, 7, 30, STONE) // a ceiling one block above the ledge top
    expect(moveBox(world, body(10.5, 5, 10.5), [2, -0.01, 0], { stepHeight: 1 })).toMatchObject({ blockedX: true, stepped: 0 })
    const low = floored()
    low.fill(12, 5, 0, 12, 5, 30, STONE)
    low.set(10, 7, 10, STONE) // a ceiling over the body: only 0.2 of lift
    expect(moveBox(low.world, body(10.5, 5, 10.5), [2, -0.01, 0], { stepHeight: 1 })).toMatchObject({ blockedX: true, stepped: 0 })
  })
  it('does not step in the air', () => {
    const { world, fill } = floored()
    fill(12, 5, 0, 12, 12, 30, STONE)
    fill(13, 5, 0, 13, 7, 30, STONE)
    const r = moveBox(world, body(10.5, 8, 10.5), [2, -0.01, 0], { stepHeight: 1 })
    expect(r).toMatchObject({ blockedX: true, stepped: 0, grounded: false })
  })
  it('steps after landing in the same move', () => {
    const { world, fill } = floored()
    fill(12, 5, 0, 12, 5, 30, STONE)
    const r = moveBox(world, body(10.5, 5.0005, 10.5), [2, -0.01, 0], { stepHeight: 1 })
    expect(r.dx).toBe(2)
    expect(5.0005 + r.dy).toBeCloseTo(6, 9)
  })
  it('does not bob against a tall wall when the other axis is free', () => {
    const { world, fill } = floored()
    fill(12, 5, 0, 12, 10, 30, STONE)
    const r = moveBox(world, body(10.5, 5, 10.5), [2, 0, 1], { stepHeight: 1 })
    expect(r).toMatchObject({ dz: 1, blockedX: true, stepped: 0, dy: 0 })
  })
  it('keeps stepped at 0, never negative, over a ledge followed by a hole', () => {
    const { world, fill } = makeWorld()
    fill(0, 4, 0, 12, 4, 30, STONE) // floor only up to x = 12
    fill(12, 5, 0, 12, 5, 30, STONE) // a one-wide ledge; beyond it a hole to the world floor
    const r = moveBox(world, body(10.5, 5, 10.5), [3, -0.01, 0], { stepHeight: 1 })
    expect(r.dx).toBe(3)
    expect(r.stepped).toBe(0)
    expect(r.dy).toBe(0)
    expect(r.grounded).toBe(false)
    expect(boxOverlapsSolid(world, after(body(10.5, 5, 10.5), r))).toBe(false)
  })
  it('treats non-finite input as no motion and fills the out object', () => {
    const { world } = floored()
    expect(moveBox(world, body(NaN, 5, 10.5), [1, 0, 0])).toMatchObject({ dx: 0, dy: 0, dz: 0, grounded: false, ceiling: false, stepped: 0 })
    const out = { dx: 9, dy: 9, dz: 9, blockedX: true, blockedY: true, blockedZ: true, grounded: false, ceiling: true, stepped: 9 }
    expect(moveBox(world, body(10.5, 5, 10.5), [1, 0, 0], { stepHeight: Infinity }, out)).toBe(out)
    expect(out).toEqual({ dx: 1, dy: 0, dz: 0, blockedX: false, blockedY: false, blockedZ: false, grounded: true, ceiling: false, stepped: 0 })
  })
})

describe('unstick', () => {
  it('is 0 for a free box', () => {
    const { world } = floored()
    expect(unstick(world, body(10.5, 5, 10.5), 1)).toBe(0)
    expect(unstick(world, body(10.5, 5, 10.5), NaN)).toBe(0)
  })
  it('lifts a box out of a block edited in at its feet, within maxUp', () => {
    const { world, set } = floored()
    set(10, 5, 10, STONE)
    expect(unstick(world, body(10.5, 5, 10.5), 1.5)).toBe(1)
    expect(unstick(world, body(10.5, 5, 10.5), 0.5)).toBeNull()
    expect(unstick(world, body(10.5, 5.3, 10.5), 1)).toBeCloseTo(0.7, 9)
  })
  it('cannot clear a block in the head region with a small lift', () => {
    const { world, set } = floored()
    set(10, 6, 10, STONE)
    expect(unstick(world, body(10.5, 5, 10.5), 1.5)).toBeNull()
    expect(unstick(world, body(10.5, 5, 10.5), 2)).toBe(2)
  })
  it('accounts for a ceiling above', () => {
    const { world, set } = floored()
    set(10, 5, 10, STONE); set(10, 7, 10, STONE)
    expect(unstick(world, body(10.5, 5, 10.5), 1.5)).toBeNull()
    expect(unstick(world, body(10.5, 5, 10.5), 3)).toBe(3)
  })
  it('returns null for bad maxUp, a non-finite box, or a box outside the world, and terminates', () => {
    const { world, set } = floored()
    set(10, 5, 10, STONE)
    expect(unstick(world, body(10.5, 5, 10.5), -1)).toBeNull()
    expect(unstick(world, body(10.5, 5, 10.5), Infinity)).toBeNull()
    expect(unstick(world, body(NaN, 5, 10.5), 1)).toBeNull()
    expect(unstick(world, body(0.1, 5, 10.5), 1e9)).toBeNull()
  })
})

const water = (level: number) => packVoxel(WATER, level)

describe('liquidAt', () => {
  it('is under the surface inside a liquid cell below its fill', () => {
    const { world, set } = makeWorld()
    set(10, 5, 10, water(7))   // full
    set(11, 5, 10, water(3))   // fill 0.5
    set(12, 5, 10, packVoxel(SPRING, 0)) // a spring counts as full
    set(13, 5, 10, STONE)
    expect(liquidAt(world, 10.5, 5.99, 10.5)).toBe(true)
    expect(liquidAt(world, 10.5, 6, 10.5)).toBe(false)
    expect(liquidAt(world, 11.5, 5.49, 10.5)).toBe(true)
    expect(liquidAt(world, 11.5, 5.5, 10.5)).toBe(false)
    expect(liquidAt(world, 12.5, 5.9, 10.5)).toBe(true)
    expect(liquidAt(world, 13.5, 5.5, 10.5)).toBe(false)
    expect(liquidAt(world, -0.5, 5.5, 10.5)).toBe(false)
    expect(liquidAt(world, 10.5, NaN, 10.5)).toBe(false)
  })
})

describe('liquidInBox', () => {
  it('measures a submerged body and finds the surface above it', () => {
    const { world, set } = makeWorld()
    set(10, 5, 10, water(7)); set(10, 6, 10, water(7)); set(10, 7, 10, water(3)) // surface at 7.5
    const r = liquidInBox(world, body(10.5, 5, 10.5), 6.6)
    expect(r.submerged).toBeCloseTo(1, 9)
    expect(r.surfaceY).toBeCloseTo(7.5, 9)
    expect(r.eyeUnder).toBe(true)
    expect(liquidInBox(world, body(10.5, 5, 10.5), 7.6).eyeUnder).toBe(false)
    expect(liquidInBox(world, body(10.5, 5, 10.5)).eyeUnder).toBe(false)
  })
  it('takes the max over the footprint columns and the surface from that column', () => {
    const { world, set } = makeWorld()
    set(10, 5, 10, water(7)) // column 10 wet to 6, column 11 dry
    const r = liquidInBox(world, body(11, 5, 10.5), 5.5)
    expect(r.submerged).toBeCloseTo(1 / 1.8, 9)
    expect(r.surfaceY).toBeCloseTo(6, 9)
    expect(r.eyeUnder).toBe(false) // the centre x = 11 is in the dry column
  })
  it('sees water under and over a bridge deck as separate runs', () => {
    const { world, set } = makeWorld()
    set(10, 5, 10, water(7)); set(10, 6, 10, STONE); set(10, 7, 10, water(7)); set(10, 8, 10, water(1))
    const under = liquidInBox(world, body(10.5, 5, 10.5))
    expect(under.submerged).toBeCloseTo(1 / 1.8, 9)
    expect(under.surfaceY).toBeCloseTo(6, 9)
    const over = liquidInBox(world, body(10.5, 7, 10.5))
    expect(over.submerged).toBeCloseTo(1.25 / 1.8, 9)
    expect(over.surfaceY).toBeCloseTo(8.25, 9)
  })
  it('is dry above a shallow partial cell, in air and outside the world', () => {
    const { world, set } = makeWorld()
    set(10, 5, 10, water(3)) // water to 5.5
    expect(liquidInBox(world, body(10.5, 5.6, 10.5))).toEqual({ submerged: 0, eyeUnder: false, surfaceY: null })
    expect(liquidInBox(world, body(20.5, 5, 20.5), 6)).toEqual({ submerged: 0, eyeUnder: false, surfaceY: null })
    expect(liquidInBox(world, body(-10, 5, -10), 6)).toEqual({ submerged: 0, eyeUnder: false, surfaceY: null })
    expect(liquidInBox(world, body(NaN, 5, 10.5), 6)).toEqual({ submerged: 0, eyeUnder: false, surfaceY: null })
  })
})
