import { describe, expect, it } from 'vitest'
import { WindMask } from '../src/render/decorations/windMask.ts'

describe('WindMask', () => {
  it('a new mask is all exposed', () => {
    const m = new WindMask(4, 4)
    expect(m.data.length).toBe(16)
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) expect(m.at(x, z)).toBe(255)
  })

  it('set copies values and fires onChange once', () => {
    const m = new WindMask(4, 4)
    let calls = 0
    m.onChange = () => { calls++ }
    const values = new Uint8Array(16).map((_, i) => i * 10)
    m.set(values)
    expect(calls).toBe(1)
    expect([...m.data]).toEqual([...values])
    values[0] = 99
    expect(m.data[0]).toBe(0) // a copy, not a view of the caller's array
    m.set(m.data.slice()) // nothing changed: no re-upload
    expect(calls).toBe(1)
  })

  it('at reads the column\'s cell', () => {
    const m = new WindMask(4, 4)
    const values = new Array<number>(16).fill(255)
    values[2 * 4 + 1] = 7 // cell (1, 2)
    m.set(values)
    expect(m.at(5, 9)).toBe(7)
    expect(m.at(4, 8)).toBe(7)
    expect(m.at(7, 11)).toBe(7)
    expect(m.at(8, 9)).toBe(255)
    expect(m.at(3, 9)).toBe(255)
  })

  it('at clamps outside the world', () => {
    const m = new WindMask(4, 4)
    const values = new Array<number>(16).fill(255)
    values[3 * 4 + 0] = 11 // cell (0, 3): x clamps to 0, z to 3
    m.set(values)
    expect(m.at(-3, 99)).toBe(11)
    expect(m.at(-3.5, 15.9)).toBe(11)
  })

  it('rejects a bad size or a set of the wrong length', () => {
    expect(() => new WindMask(0, 4)).toThrow(RangeError)
    expect(() => new WindMask(4, 2.5)).toThrow(RangeError)
    const m = new WindMask(4, 4)
    expect(() => m.set(new Uint8Array(15))).toThrow(RangeError)
    expect(() => m.set(new Array<number>(16).fill(300))).toThrow(RangeError)
    expect(m.data.every(v => v === 255)).toBe(true)
  })
})
