import { describe, expect, it } from 'vitest'
import { pack, unpack } from '../src/persist/pack.ts'
import { gunzip, gzip, sha256 } from '../src/persist/codec.ts'

describe('section packing', () => {
  it('round-trips JSON and every array type, aligned', () => {
    const p = {
      json: { a: 1, list: [3, 'x'], nested: { ok: true } },
      arrays: {
        i32: Int32Array.from([-1, 2, 2147483647]), u32: Uint32Array.from([4294967295, 0]),
        i16: Int16Array.from([-32768, 7]), u16: Uint16Array.from([65535, 1, 2]), u8: Uint8Array.from([255]),
        empty: new Int32Array(0),
      },
    }
    const back = unpack(pack(p))
    expect(back.json).toEqual(p.json)
    for (const [k, v] of Object.entries(p.arrays)) {
      expect(back.arrays[k]!.constructor).toBe(v.constructor)
      expect([...back.arrays[k]!]).toEqual([...v])
      expect(back.arrays[k]!.byteOffset % 4).toBe(0)
    }
  })
  it('packs a view into a larger buffer by its own bytes only', () => {
    const big = Int32Array.from([9, 8, 7, 6])
    const back = unpack(pack({ json: null, arrays: { v: big.subarray(1, 3) } }))
    expect([...back.arrays.v!]).toEqual([8, 7])
  })
  it('refuses bytes that are not a pack', () => {
    expect(() => unpack(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/not a packed section/)
  })
})

describe('blob codec', () => {
  it('gzip round-trips and shrinks zeros', async () => {
    const zeros = new Uint8Array(1 << 20)
    const z = await gzip(zeros)
    expect(z.length).toBeLessThan(4096)
    expect(await gunzip(z)).toEqual(zeros)
  })
  it('sha256 is the hex digest', async () => {
    expect(await sha256(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
