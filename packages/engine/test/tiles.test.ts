import { describe, expect, it } from 'vitest'
import { TILE, checkTextureScale, checkTileSize, checkerTile, layerScales, packTiles, dilateAlpha } from '../src/render/tiles.ts'

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

describe('dilateAlpha', () => {
  const S = 16
  const at = (x: number, y: number) => (y * S + x) * 4
  function tile(): Uint8Array {
    const px = new Uint8Array(S * S * 4) // transparent black
    px.set([200, 40, 20, 255], at(1, 1)) // one opaque red texel
    return px
  }
  it('bleeds opaque colour into neighbouring transparent texels without touching alpha', () => {
    const out = dilateAlpha(tile(), S, 1)
    expect([...out.subarray(at(2, 2), at(2, 2) + 4)]).toEqual([200, 40, 20, 0])
    expect([...out.subarray(at(0, 0), at(0, 0) + 4)]).toEqual([200, 40, 20, 0])
    expect([...out.subarray(at(3, 3), at(3, 3) + 4)]).toEqual([0, 0, 0, 0]) // two texels away after one pass
  })
  it('wraps around the tile edges', () => {
    const out = dilateAlpha(tile(), S, 2)
    expect([...out.subarray(at(S - 1, S - 1), at(S - 1, S - 1) + 3)]).toEqual([200, 40, 20])
  })
  it('stops after `passes` texels and never changes alpha', () => {
    const src = tile()
    const out = dilateAlpha(src, S, 4)
    expect([...out.subarray(at(9, 9), at(9, 9) + 4)]).toEqual([0, 0, 0, 0])
    for (let i = 3; i < out.length; i += 4) expect(out[i]).toBe(src[i])
  })
  it('leaves fully opaque tiles unchanged', () => {
    const px = new Uint8Array(S * S * 4).fill(255)
    expect(dilateAlpha(px, S)).toEqual(px)
  })
})

describe('checkTileSize', () => {
  it('accepts powers of two from 16 to 1024 and returns them', () => {
    expect(checkTileSize(TILE)).toBe(64)
    expect(checkTileSize(128)).toBe(128)
    expect(checkTileSize(16)).toBe(16)
    expect(checkTileSize(1024)).toBe(1024)
  })
  it('rejects anything else with the option name', () => {
    for (const bad of [0, 8, 100, 2048, 64.5, Number.NaN]) expect(() => checkTileSize(bad)).toThrow(/tileSize/)
  })
  it('packs tiles at the chosen size', () => {
    const p = packTiles(['a'], () => solid(128, 10, 20, 30), 128)
    expect(p.data.length).toBe(2 * 128 * 128 * 4)
    expect([...p.data.subarray(128 * 128 * 4, 128 * 128 * 4 + 4)]).toEqual([10, 20, 30, 255])
  })
})

describe('texture scale', () => {
  const names = ['grass_top', 'dirt', 'stone']
  it('accepts positive scales for known textures', () => {
    expect(checkTextureScale({ grass_top: 3, dirt: 0.5 }, names)).toEqual({ grass_top: 3, dirt: 0.5 })
    expect(checkTextureScale(undefined, names)).toEqual({})
  })
  it('rejects unknown textures and bad numbers with the field name', () => {
    expect(() => checkTextureScale({ gras_top: 2 }, names)).toThrow(/textureScale\.gras_top: unknown texture/)
    for (const bad of [0, -1, Number.NaN, Infinity, 65]) expect(() => checkTextureScale({ dirt: bad }, names)).toThrow(/textureScale\.dirt/)
  })
  it('maps scales onto texture-array layers, 1 everywhere else', () => {
    const layerOf = new Map([['grass_top', 1], ['dirt', 2], ['stone', 3]])
    expect([...layerScales(layerOf, 4, { grass_top: 3 })]).toEqual([1, 3, 1, 1])
    // a texture without a loaded image has no layer: its scale is ignored
    expect([...layerScales(new Map([['dirt', 1]]), 2, { grass_top: 3 })]).toEqual([1, 1])
  })
})
