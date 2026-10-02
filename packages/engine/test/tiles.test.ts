import { describe, expect, it } from 'vitest'
import { TILE, checkerTile, packTiles } from '../src/render/tiles.ts'

function solid(size: number, r: number, g: number, b: number): Uint8Array {
  const px = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) px.set([r, g, b, 255], i * 4)
  return px
}

describe('packTiles', () => {
  it('puts the checker at layer 0 and present tiles after it', () => {
    const tiles: Record<string, Uint8Array> = { stone: solid(4, 128, 128, 128), dirt: solid(4, 100, 60, 30) }
    const p = packTiles(['stone', 'missing', 'dirt'], (n) => tiles[n] ?? null, 4)
    expect(p.layers).toBe(3)
    expect([...p.layerOf]).toEqual([['stone', 1], ['dirt', 2]])
    expect(p.missing).toEqual(['missing'])
    expect(p.data.length).toBe(3 * 4 * 4 * 4)
    expect(Array.from(p.data.subarray(0, 4))).toEqual(Array.from(checkerTile(4).subarray(0, 4)))
    expect(Array.from(p.data.subarray(64, 68))).toEqual([128, 128, 128, 255])
  })
  it('flips rows so the top of the image is v = 1', () => {
    const img = new Uint8Array(2 * 2 * 4)
    img.set([255, 0, 0, 255], 0) // top-left red
    const p = packTiles(['t'], () => img, 2)
    const layer = p.data.subarray(16, 32)
    expect(Array.from(layer.subarray(8, 12))).toEqual([255, 0, 0, 255]) // now on the last row
  })
  it('rejects tiles of the wrong size', () => {
    expect(() => packTiles(['a'], () => new Uint8Array(10), 4)).toThrow(/expected 64 bytes/)
  })
  it('has a 64px default with a magenta/black checker', () => {
    expect(TILE).toBe(64)
    const c = checkerTile()
    expect(c.length).toBe(64 * 64 * 4)
    expect(Array.from(c.subarray(0, 4))).toEqual([255, 0, 255, 255])
    expect(Array.from(c.subarray(8 * 4, 8 * 4 + 4))).toEqual([0, 0, 0, 255])
  })
})
