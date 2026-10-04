import { describe, expect, it } from 'vitest'
import { SEAMLESS_X, SEAMLESS_Y, paintTiles } from '../src/paint/index.ts'
import { SIZE } from '../src/paint/raster.ts'

const tiles = paintTiles()
const NAMES = ['stone', 'dirt', 'grass_top', 'grass_side', 'sand', 'log_side', 'log_top', 'planks', 'leaves', 'rock', 'glass', 'torch', 'water', 'snow', 'gravel', 'sandstone', 'sandstone_red', 'pine_leaves', 'mud', 'wet_sand']

function pairDiffs(px: Uint8ClampedArray, axis: 'x' | 'y'): number[] {
  const at = (x: number, y: number, c: number) => px[(y * SIZE + x) * 4 + c]!
  const out: number[] = []
  for (let k = 0; k < SIZE; k++) {
    const k2 = (k + 1) % SIZE
    let s = 0
    for (let m = 0; m < SIZE; m++) for (let c = 0; c < 3; c++) {
      s += axis === 'x' ? Math.abs(at(k, m, c) - at(k2, m, c)) : Math.abs(at(m, k, c) - at(m, k2, c))
    }
    out.push(s / (SIZE * 3))
  }
  return out // out[SIZE - 1] is the seam pair (63 → 0)
}
function seamOk(px: Uint8ClampedArray, axis: 'x' | 'y'): boolean {
  const d = pairDiffs(px, axis)
  const seam = d[SIZE - 1]!
  const interior = d.slice(0, SIZE - 1).sort((a, b) => a - b)
  return seam <= 1.5 * interior[Math.floor(interior.length * 0.9)]! + 1
}

describe('paintTiles', () => {
  it('paints every tile the sandbox blocks use, as 64×64 RGBA', () => {
    expect(Object.keys(tiles).sort()).toEqual([...NAMES].sort())
    for (const n of NAMES) expect(tiles[n]!.length).toBe(SIZE * SIZE * 4)
  })
  it('is deterministic', () => {
    expect(paintTiles()).toEqual(tiles)
  })
  it.each(SEAMLESS_X)('%s tiles horizontally', (n) => expect(seamOk(tiles[n]!, 'x')).toBe(true))
  it.each(SEAMLESS_Y)('%s tiles vertically', (n) => expect(seamOk(tiles[n]!, 'y')).toBe(true))
  it('keeps solid tiles opaque and gives leaves holes', () => {
    for (const n of ['stone', 'dirt', 'grass_top', 'grass_side', 'sand', 'log_side', 'log_top', 'planks', 'rock', 'snow', 'gravel', 'sandstone', 'sandstone_red', 'mud', 'wet_sand']) {
      const px = tiles[n]!
      for (let i = 3; i < px.length; i += 4) expect(px[i]).toBe(255)
    }
    const leaves = tiles.leaves!
    let holes = 0
    for (let i = 3; i < leaves.length; i += 4) if (leaves[i] === 0) holes++
    expect(holes).toBeGreaterThan(SIZE * SIZE * 0.05)
    expect(holes).toBeLessThan(SIZE * SIZE * 0.5)
  })
  it('puts the green fringe at the top of grass_side', () => {
    const px = tiles.grass_side!
    const g = (y: number) => { let s = 0; for (let x = 0; x < SIZE; x++) s += px[(y * SIZE + x) * 4 + 1]! - px[(y * SIZE + x) * 4]!; return s / SIZE }
    expect(g(2)).toBeGreaterThan(20) // green dominates red at the top
    expect(g(60)).toBeLessThan(0) // dirt (red-brown) at the bottom
  })
})
