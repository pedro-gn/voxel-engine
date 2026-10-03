import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64 } from '../src/doc/base64.ts'
import { Check, checkNoise } from '../src/doc/check.ts'

describe('Check', () => {
  it('collects every error with its path', () => {
    const c = new Check()
    c.num('a', 'x')
    c.num('b', 1.5, { int: true })
    c.num('c', -1, { min: 0 })
    c.num('d', 0, { gt: 0 })
    c.str('e', 'q', ['p', 'r'])
    c.arr('f', [1], 2)
    c.range('g', [3, 1])
    c.vec2('h', [1])
    c.obj('i', undefined)
    c.bool('j', 1)
    expect(c.errors).toEqual([
      'a: must be a finite number',
      'b: must be an integer',
      'c: must be >= 0',
      'd: must be > 0',
      'e: must be one of p, r',
      'f: must have at least 2 items',
      'g: min must be <= max',
      'h: must be [x, z]',
      'i: is required',
      'j: must be true or false',
    ])
  })
  it('accepts valid values and skips optional missing ones', () => {
    const c = new Check()
    expect(c.num('a', 3, { int: true, min: 0, max: 3 })).toBe(true)
    expect(c.num('b', undefined, { optional: true })).toBe(false)
    expect(c.str('c', undefined, undefined, true)).toBe(false)
    expect(c.range('d', [1, 1])).toBe(true)
    expect(c.errors).toEqual([])
  })
})

describe('checkNoise', () => {
  it('validates every field', () => {
    const c = new Check()
    checkNoise(c, 'n', { type: 'wavy', scale: 0, octaves: 9, warp: { scale: 10, amount: -1 } })
    expect(c.errors).toEqual([
      'n.type: must be one of fbm, ridged, billow, cellular',
      'n.scale: must be > 0',
      'n.octaves: must be <= 8',
      'n.warp.amount: must be >= 0',
    ])
  })
  it('accepts a minimal definition', () => {
    const c = new Check()
    checkNoise(c, 'n', { scale: 32 })
    expect(c.errors).toEqual([])
  })
})

describe('base64', () => {
  it('round-trips bytes, including large arrays', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 37) & 255)
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
    expect(bytesToBase64(new Uint8Array([104, 105]))).toBe('aGk=')
  })
})
