import { describe, expect, it } from 'vitest'
import { GrassMask } from '../src/render/decorations/grassMask.ts'

describe('GrassMask', () => {
  it('starts full everywhere: today\'s grass', () => {
    const m = new GrassMask(64, 32)
    expect(m.data.length).toBe(64 * 32)
    expect(m.data.every(v => v === 255)).toBe(true)
    expect(m.get(0, 0)).toBe(1); expect(m.get(63, 31)).toBe(1)
  })
  it('stores a column\'s factor row-major over x (width) and z (rows), quantised to bytes', () => {
    const m = new GrassMask(64, 32)
    m.set(5, 7, 0); m.set(6, 7, 0.5)
    expect(m.data[7 * 64 + 5]).toBe(0); expect(m.get(5, 7)).toBe(0)
    expect(m.data[7 * 64 + 6]).toBe(128); expect(m.get(6, 7)).toBeCloseTo(0.5, 2)
    expect(m.get(7, 7)).toBe(1)
  })
  it('sets many columns at once from flat [x, z, x, z, …] pairs', () => {
    const m = new GrassMask(16, 16)
    m.setMany([1, 2, 3, 4], 0.25)
    expect(m.get(1, 2)).toBeCloseTo(0.25, 2); expect(m.get(3, 4)).toBeCloseTo(0.25, 2); expect(m.get(2, 1)).toBe(1)
  })
  it('clears back to full', () => {
    const m = new GrassMask(16, 16)
    m.setMany([1, 2, 3, 4], 0); m.clear()
    expect(m.data.every(v => v === 255)).toBe(true)
  })
  it('tells its owner when it changes (the texture re-uploads), and not for a no-op', () => {
    const m = new GrassMask(16, 16)
    let n = 0
    m.onChange = () => { n++ }
    m.set(1, 1, 0); expect(n).toBe(1)
    m.set(1, 1, 0); expect(n).toBe(1) // same value: nothing to upload
    m.setMany([2, 2, 3, 3], 0); expect(n).toBe(2)
    m.clear(); expect(n).toBe(3)
    m.clear(); expect(n).toBe(3)
  })
  it('validates columns and values; a bad batch writes nothing', () => {
    const m = new GrassMask(16, 16)
    expect(() => m.set(-1, 0, 0)).toThrow(RangeError)
    expect(() => m.set(16, 0, 0)).toThrow(RangeError)
    expect(() => m.set(0, 16, 0)).toThrow(RangeError)
    expect(() => m.set(0.5, 0, 0)).toThrow(RangeError)
    expect(() => m.set(0, 0, 1.5)).toThrow(RangeError)
    expect(() => m.set(0, 0, -0.1)).toThrow(RangeError)
    expect(() => m.set(0, 0, Number.NaN)).toThrow(RangeError)
    expect(() => m.get(99, 0)).toThrow(RangeError)
    expect(() => m.setMany([1, 1, 2], 0)).toThrow(RangeError) // odd length
    expect(() => m.setMany([1, 1, 99, 0], 0)).toThrow(RangeError)
    expect(m.get(1, 1)).toBe(1) // the valid first pair of the bad batch was not written
  })
  it('rejects a bad size', () => {
    expect(() => new GrassMask(0, 16)).toThrow(RangeError)
    expect(() => new GrassMask(16, 2.5)).toThrow(RangeError)
  })
})
