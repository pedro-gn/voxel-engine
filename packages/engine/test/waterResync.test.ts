import { describe, expect, it } from 'vitest'
import { AIR } from '../src/world/voxel.ts'
import { B, run, w, waterSim, type Fill } from './waterHelpers.ts'

/** A walled lake (x, z < 20) draining through a gap in its x = 19 wall onto open ground; 64 × 32 × 64 (16 tiles). */
const world: Fill = (x, y, z) => {
  if (y === 0) return B.stone
  if (x < 20 && z < 20) {
    if (y > 8) return AIR
    const wall = x === 0 || z === 0 || x === 19 || z === 19
    if (wall) return x === 19 && z === 10 && y >= 4 ? AIR : B.stone
    return w(7)
  }
  return y <= 2 ? B.stone : AIR
}

describe('waterResync (4a-r2 #2, spec 4.5)', () => {
  it('the next publish lists every tile, and the world hash stays what it would be without it', () => {
    const a = waterSim(world, { size: [64, 32, 64] }), b = waterSim(world, { size: [64, 32, 64] })
    run(a, 10); run(b, 10)
    b.water.republishAll()
    const ta = a.step().water, tb = b.step().water
    expect(tb!.tiles.length).toBe(16)
    expect(ta === null || ta.tiles.length < 16).toBe(true)
    expect(b.hash()).toBe(a.hash())
    for (let i = 0; i < 30; i++) { a.step(); b.step(); expect(b.hash()).toBe(a.hash()) }
  })
})
