import { describe, expect, it } from 'vitest'
import { LayerCut } from '../src/render/layerCut.ts'
import { Layout } from '../src/world/layout.ts'

const L = new Layout([64, 96, 64]) // 2 × 3 × 2 chunks
const ci = (cx: number, cy: number, cz: number) => L.chunkIndex(cx, cy, cz)

describe('LayerCut', () => {
  it('hides chunks above the cut and crosses the cut layer', () => {
    const c = new LayerCut(L)
    const remesh = c.set(40)
    expect(c.hides(ci(0, 2, 0))).toBe(true)
    expect(c.crosses(ci(0, 1, 0))).toBe(true)
    expect(c.hides(ci(0, 1, 0))).toBe(false)
    expect(c.crosses(ci(0, 0, 0))).toBe(false)
    expect(remesh.sort()).toEqual([ci(0, 1, 0), ci(1, 1, 0), ci(0, 1, 1), ci(1, 1, 1)].sort())
    expect(c.top).toBe(41)
  })

  it('moving the cut to another layer remeshes both layers; null restores everything', () => {
    const c = new LayerCut(L)
    c.set(40)
    expect(c.set(70).length).toBe(8)
    expect(c.set(null).length).toBe(4)
    expect(c.hides(ci(0, 2, 0))).toBe(false)
    expect(c.top).toBe(Infinity)
  })

  it('stale cut results are dropped and re-queued', () => {
    const c = new LayerCut(L)
    c.set(40)
    expect(c.expected(ci(0, 1, 0))).toBe(40)
    c.set(41)
    expect(c.expected(ci(0, 1, 0))).toBe(41) // a result meshed with cut 40 no longer matches
    expect(c.expected(ci(0, 0, 0))).toBeUndefined()
  })

  it('rejects heights outside the world', () => {
    const c = new LayerCut(L)
    expect(() => c.set(-1)).toThrow(RangeError)
    expect(() => c.set(96)).toThrow(RangeError)
    expect(() => c.set(1.5)).toThrow(RangeError)
  })
})
