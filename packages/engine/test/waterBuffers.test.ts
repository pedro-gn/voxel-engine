import { describe, expect, it } from 'vitest'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { NO_FLOOR } from '../src/world/waterBuffers.ts'

describe('water buffers', () => {
  it('are sized per column and start empty: no floor, dry surfaces, nothing published', () => {
    const b = createWorldBuffers([64, 32, 96]).water
    const floor = new Int16Array(b.floor)
    expect(floor.length).toBe(64 * 96)
    expect(floor.every((f) => f === NO_FLOOR)).toBe(true)
    const surface = new Int32Array(b.surface)
    expect(surface.length).toBe(2 * 64 * 96)
    expect(surface.every((s) => s === -1)).toBe(true)
    expect(new Int16Array(b.flux).length).toBe(4 * 64 * 96)
    expect([...new Int32Array(b.stamp)]).toEqual([-1, -1])
  })
})
