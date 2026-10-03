import { describe, expect, it } from 'vitest'
import { CHANGED, NEG_X, NEG_Y, NEG_Z, POS_X, POS_Y, POS_Z, diffMask, forNeighbours } from '../src/sim/chunkDiff.ts'
import { CHUNK_VOLUME, Layout } from '../src/world/layout.ts'

const at = (lx: number, ly: number, lz: number) => Layout.localIndex(lx, ly, lz)
function changed(...points: [number, number, number][]): Uint16Array {
  const a = new Uint16Array(CHUNK_VOLUME)
  for (const [x, y, z] of points) a[at(x, y, z)] = 1
  return a
}
function neighbours(mask: number): string[] {
  const out: string[] = []
  forNeighbours(mask, (dx, dy, dz) => out.push(`${dx},${dy},${dz}`))
  return out.sort()
}
const blank = new Uint16Array(CHUNK_VOLUME)

describe('diffMask', () => {
  it('is 0 for equal chunks', () => {
    expect(diffMask(blank, new Uint16Array(CHUNK_VOLUME))).toBe(0)
  })

  it('flags an interior change without border slabs', () => {
    expect(diffMask(blank, changed([16, 16, 16]))).toBe(CHANGED)
  })

  it('flags every border slab a difference lies on', () => {
    expect(diffMask(blank, changed([0, 5, 31]))).toBe(CHANGED | NEG_X | POS_Z)
    expect(diffMask(blank, changed([31, 31, 31]))).toBe(CHANGED | POS_X | POS_Y | POS_Z)
    expect(diffMask(blank, changed([5, 0, 5], [5, 31, 5]))).toBe(CHANGED | NEG_Y | POS_Y)
  })

  it('compares light arrays too', () => {
    const a = new Uint8Array(CHUNK_VOLUME), b = new Uint8Array(CHUNK_VOLUME)
    b[at(31, 4, 4)] = 15
    expect(diffMask(a, b)).toBe(CHANGED | POS_X)
  })
})

describe('forNeighbours', () => {
  it('visits nothing for no change or an interior change', () => {
    expect(neighbours(0)).toEqual([])
    expect(neighbours(CHANGED)).toEqual([])
  })

  it('visits the face, edge and corner neighbours whose facing slabs all changed', () => {
    expect(neighbours(CHANGED | NEG_X | POS_Z)).toEqual(['-1,0,0', '-1,0,1', '0,0,1'])
    expect(neighbours(CHANGED | POS_X | POS_Y | POS_Z)).toEqual(['0,0,1', '0,1,0', '0,1,1', '1,0,0', '1,0,1', '1,1,0', '1,1,1'])
  })

  it('visits all 26 neighbours when every slab changed', () => {
    expect(neighbours(CHANGED | NEG_X | POS_X | NEG_Y | POS_Y | NEG_Z | POS_Z)).toHaveLength(26)
  })
})
