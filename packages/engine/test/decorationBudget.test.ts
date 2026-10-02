import { describe, expect, it } from 'vitest'
import { CHUNK_REACH, selectVisible } from '../src/render/decorations/budget.ts'

describe('selectVisible', () => {
  const chunks = [
    { ci: 1, dist: 10, count: 100 },
    { ci: 2, dist: 50, count: 100 },
    { ci: 3, dist: 96 + CHUNK_REACH + 1, count: 1 },
    { ci: 4, dist: 30, count: 100 },
  ]
  it('takes every chunk within reach of the radius', () => {
    expect(selectVisible(chunks, 96, 1e9)).toEqual(new Set([1, 2, 4]))
  })
  it('fills the instance ceiling nearest first', () => {
    expect(selectVisible(chunks, 96, 250)).toEqual(new Set([1, 4]))
    expect(selectVisible(chunks, 96, 0)).toEqual(new Set())
  })
})
