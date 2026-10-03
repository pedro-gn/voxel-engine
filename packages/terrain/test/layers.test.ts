import { describe, expect, it } from 'vitest'
import { Check } from '../src/doc/check.ts'
import { BiomeLayer, DensityLayer, HeightLayer, checkLayers, decodeRaster, encodeBrick, encodeRaster } from '../src/layers/raster.ts'

describe('rasters', () => {
  it('round-trips i16 (negative values included) and u8', () => {
    const i16 = Int16Array.from([0, -1, 300, -32768, 32767, 5])
    expect(decodeRaster(encodeRaster('i16', 3, 2, i16))).toEqual(i16)
    const u8 = Uint8Array.from([0, 1, 2, 255])
    expect(decodeRaster(encodeRaster('u8', 2, 2, u8))).toEqual(u8)
  })
  it('rejects a size mismatch', () => {
    expect(() => encodeRaster('u8', 3, 3, new Uint8Array(4))).toThrow(RangeError)
    expect(() => decodeRaster({ width: 3, height: 3, type: 'u8', data: 'AAAA' })).toThrow(/expected 9/)
  })
})

describe('HeightLayer / BiomeLayer', () => {
  it('reads per-column heights', () => {
    const v = new Int16Array(64 * 32)
    v[5 + 7 * 64] = -12
    const layer = new HeightLayer(encodeRaster('i16', 64, 32, v))
    expect(layer.at(5, 7)).toBe(-12)
    expect(layer.at(6, 7)).toBe(0)
  })
  it('reads 4 × 4-column biome cells, -1 where unpainted', () => {
    const v = new Uint8Array(16 * 8)
    v[2 + 1 * 16] = 3 // biome index 2
    const layer = new BiomeLayer(encodeRaster('u8', 16, 8, v))
    expect(layer.at(8, 4)).toBe(2)
    expect(layer.at(11, 7)).toBe(2)
    expect(layer.at(12, 7)).toBe(-1)
  })
})

describe('DensityLayer', () => {
  const samples = new Int8Array(512)
  samples[1 + 1 * 8 + 1 * 64] = 80 // sample (1, 1, 1) of brick (1, 0, 0) = block (18, 2, 2): +10 blocks
  const layer = new DensityLayer({ bricks: [encodeBrick(1, 0, 0, samples)] })
  it('samples exactly on grid points and interpolates between them', () => {
    expect(layer.sample(18, 2, 2)).toBe(10)
    expect(layer.sample(19, 2, 2)).toBe(5)
    expect(layer.sample(17, 3, 2)).toBe(2.5)
    expect(layer.sample(100, 2, 2)).toBe(0)
  })
  it('knows which columns it can touch', () => {
    expect(layer.touches(0, 0, 13, 40)).toBe(false)
    expect(layer.touches(0, 0, 14, 40)).toBe(true)
    expect(layer.touches(33, 0, 40, 40)).toBe(false)
  })
})

describe('checkLayers', () => {
  it('validates sizes, types and brick payloads', () => {
    const c = new Check()
    checkLayers(c, 'layers', {
      height: encodeRaster('i16', 32, 32, new Int16Array(32 * 32)),
      biome: encodeRaster('u8', 4, 4, new Uint8Array(16)),
      density: { bricks: [{ x: 0, y: 0, z: -1, data: 'AAAA' }] },
    }, 64, 32, 2)
    expect(c.errors).toEqual([
      'layers.height: must be 64 × 32, got 32 × 32',
      'layers.biome: must be 16 × 8, got 4 × 4',
      'layers.density.bricks[0].z: must be >= 0',
      'layers.density.bricks[0].data: must hold 512 samples, got 3',
    ])
  })
  it('rejects a biome value past the biome count', () => {
    const v = new Uint8Array(16 * 16)
    v[2 + 3 * 16] = 3 // 2 biomes: stored 1..2 are valid
    const c = new Check()
    checkLayers(c, 'layers', { biome: encodeRaster('u8', 16, 16, v) }, 64, 64, 2)
    expect(c.errors).toEqual(['layers.biome.data: value 3 at cell (2, 3) exceeds the 2 biomes'])
    const ok = new Check()
    v[2 + 3 * 16] = 2
    checkLayers(ok, 'layers', { biome: encodeRaster('u8', 16, 16, v) }, 64, 64, 2)
    expect(ok.errors).toEqual([])
  })
  it('accepts missing layers', () => {
    const c = new Check()
    checkLayers(c, 'layers', {}, 64, 64, 2)
    checkLayers(c, 'layers', undefined, 64, 64, 2)
    expect(c.errors).toEqual([])
  })
})
