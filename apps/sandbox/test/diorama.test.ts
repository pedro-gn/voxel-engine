import { describe, expect, it } from 'vitest'
import { fbm2 } from '@elovox/engine/testing'
import { DIORAMA_SIZE, HIGH, LOW, dioramaColumn } from '../src/scenes/diorama.ts'

const noise = (x: number, z: number) => fbm2(1234, x, z, 3)
const topOf = (col: (string | null)[]) => { for (let y = col.length - 1; y >= 0; y--) if (col[y] !== null) return y; return -1 }

describe('dioramaColumn', () => {
  it('fills a full-height column with stone at the bottom', () => {
    const col = dioramaColumn(50, 20, noise)
    expect(col).toHaveLength(DIORAMA_SIZE[1])
    expect(col[0]).toBe('stone')
  })
  it('puts a grass meadow with dirt under it on the lower terrace', () => {
    const col = dioramaColumn(50, 20, noise)
    const y = topOf(col)
    expect(col[y]).toBe('grass')
    expect(col[y - 1]).toBe('dirt')
    expect(Math.abs(y - LOW)).toBeLessThanOrEqual(1)
  })
  it('holds a lake on the upper terrace and a pond on the lower one', () => {
    const lake = dioramaColumn(64, 92, noise)
    expect(lake[topOf(lake)]).toBe('water')
    expect(lake.filter((b) => b === 'water').length).toBe(5)
    expect(topOf(lake)).toBeLessThan(HIGH)
    const pond = dioramaColumn(70, 28, noise)
    expect(pond.filter((b) => b === 'water').length).toBe(3)
  })
  it('grows a tree with a trunk and a leaf canopy around it', () => {
    expect(dioramaColumn(18, 84, noise)).toContain('log')
    expect(dioramaColumn(19, 84, noise)).toContain('leaves')
  })
  it('cuts an arch: air under solid ground on the back rim', () => {
    const col = dioramaColumn(46, 120, noise)
    const hole = col.findIndex((b, y) => b === null && y < topOf(col))
    expect(hole).toBeGreaterThan(0)
  })
  it('is deterministic', () => {
    expect(dioramaColumn(33, 77, noise)).toEqual(dioramaColumn(33, 77, noise))
  })
})
