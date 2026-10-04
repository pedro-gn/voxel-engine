import { describe, expect, it } from 'vitest'
import { AO_CURVE, flipDiagonal, vertexAO } from '../src/mesh/ao.ts'
import { FLOW, flowCode, packA, packB, packFlow, unpackA, unpackB, unpackFlow } from '../src/mesh/vertexFormat.ts'

describe('vertex format', () => {
  it('round-trips word A at its limits', () => {
    const a = packA(32, 32, 32, 5, 3, 3, 16)
    expect(unpackA(a)).toEqual({ x: 32, y: 32, z: 32, normal: 5, ao: 3, corner: 3, drop: 16 })
    expect(unpackA(packA(0, 1, 2, 0, 0, 1))).toEqual({ x: 0, y: 1, z: 2, normal: 0, ao: 0, corner: 1, drop: 0 })
    expect(a).toBeLessThanOrEqual(0xffffffff)
  })
  it('round-trips word B at its limits', () => {
    expect(unpackB(packB(4095, 15, 15, 32, 32))).toEqual({ layer: 4095, sky: 15, block: 15, w: 32, h: 32 })
    expect(packB(4095, 15, 15, 63, 63)).toBeGreaterThan(0) // unsigned, even with the top bit set
  })
})

describe('ambient occlusion', () => {
  it('counts occluders, with two sides forcing full occlusion', () => {
    expect(vertexAO(false, false, false)).toBe(0)
    expect(vertexAO(false, false, true)).toBe(1)
    expect(vertexAO(true, false, true)).toBe(2)
    expect(vertexAO(true, true, false)).toBe(3)
    expect(AO_CURVE).toHaveLength(4)
  })
  it('flips to the c1–c3 diagonal when c0+c2 are darker', () => {
    expect(flipDiagonal(3, 0, 0, 0)).toBe(true)
    expect(flipDiagonal(0, 3, 0, 0)).toBe(false)
    expect(flipDiagonal(1, 1, 1, 1)).toBe(false)
  })
})

describe('flow bits', () => {
  it('round-trips every flow code through a liquid vertex without touching its other fields', () => {
    for (let code = 0; code < 32; code++) {
      const a0 = packA(31, 32, 7, 2, 1, 3, 17), b0 = packB(511, 9, 4, 1, 1)
      const [a, b] = packFlow(a0, b0, code)
      expect(unpackFlow(a, b)).toBe(code)
      expect(unpackA(a)).toEqual(unpackA(a0))
      expect(unpackB(b).layer & 511).toBe(511)
      expect(unpackB(b).sky).toBe(9)
    }
  })
  it('builds moving codes', () => {
    expect(flowCode(3, false)).toBe(FLOW.MOVING | 3)
    expect(flowCode(10, true)).toBe(FLOW.MOVING | FLOW.STEEP | 2)
  })
})
