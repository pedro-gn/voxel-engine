import { describe, expect, it } from 'vitest'
import { MAX_FILL_VOXELS, compareStamped, validateCommand, type StampedCommand } from '../src/sim/commands.ts'
import { Layout } from '../src/world/layout.ts'
import { packVoxel } from '../src/world/voxel.ts'

const L = new Layout([1024, 128, 1024])
const none = new Set<string>()
const v = (cmd: unknown, custom = none) => validateCommand(cmd as never, L, 8, custom)

describe('validateCommand', () => {
  it('accepts setBlock anywhere inside the world, including every edge', () => {
    expect(v({ type: 'setBlock', pos: [0, 0, 0], voxel: 1 })).toBeNull()
    expect(v({ type: 'setBlock', pos: [1023, 127, 1023], voxel: packVoxel(7, 15) })).toBeNull()
  })
  it('rejects positions one past the edge', () => {
    expect(v({ type: 'setBlock', pos: [0, 128, 0], voxel: 1 })).toMatch(/out of bounds/)
    expect(v({ type: 'setBlock', pos: [-1, 0, 0], voxel: 1 })).toMatch(/out of bounds/)
    expect(v({ type: 'setBlock', pos: [1.5, 0, 0], voxel: 1 })).toMatch(/out of bounds/)
    expect(v({ type: 'setBlock', pos: [1, 2], voxel: 1 })).toMatch(/pos/)
  })
  it('rejects unknown blocks and malformed voxels', () => {
    expect(v({ type: 'setBlock', pos: [0, 0, 0], voxel: 8 })).toMatch(/unknown block/)
    expect(v({ type: 'setBlock', pos: [0, 0, 0], voxel: 0x10000 })).toMatch(/voxel/)
    expect(v({ type: 'setBlock', pos: [0, 0, 0], voxel: 1.5 })).toMatch(/voxel/)
  })
  it('validates fillRegion bounds, ordering and size', () => {
    expect(v({ type: 'fillRegion', min: [0, 0, 0], max: [1023, 0, 1023], voxel: 1 })).toBeNull() // exactly 1M
    expect(MAX_FILL_VOXELS).toBe(1024 * 1024)
    expect(v({ type: 'fillRegion', min: [0, 0, 0], max: [1023, 1, 1023], voxel: 1 })).toMatch(/too large/)
    expect(v({ type: 'fillRegion', min: [5, 0, 0], max: [4, 0, 0], voxel: 1 })).toMatch(/min/)
    expect(v({ type: 'fillRegion', min: [0, 0, 0], max: [0, 128, 0], voxel: 1 })).toMatch(/out of bounds/)
  })
  it('accepts only registered custom command types', () => {
    expect(v({ type: 'explode', at: [1, 2, 3] })).toMatch(/unknown command type "explode"/)
    expect(v({ type: 'explode', at: [1, 2, 3] }, new Set(['explode']))).toBeNull()
    expect(v({})).toMatch(/unknown command type/)
  })
})

describe('compareStamped', () => {
  it('orders by tick, then clientId, then seq', () => {
    const mk = (tick: number, clientId: number, seq: number): StampedCommand =>
      ({ tick, clientId, seq, cmd: { type: 'setBlock', pos: [0, 0, 0], voxel: 1 } })
    const list = [mk(2, 0, 0), mk(1, 1, 0), mk(1, 0, 5), mk(1, 0, 2)]
    expect(list.sort(compareStamped).map((c) => [c.tick, c.clientId, c.seq]))
      .toEqual([[1, 0, 2], [1, 0, 5], [1, 1, 0], [2, 0, 0]])
  })
})
