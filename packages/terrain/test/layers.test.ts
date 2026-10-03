import { describe, expect, it } from 'vitest'
import { Check } from '../src/doc/check.ts'
import { BiomeLayer, DensityLayer, HeightLayer } from '../src/layers/layers.ts'
import { BIOME_VALUES, BRICK_VALUES, HEIGHT_VALUES, checkLayers, decodeValues, encodeValues, layersToJSON } from '../src/layers/tiles.ts'

const limits = { sizeX: 128, sizeZ: 128, height: 64, biomeCount: 2 }
function filled<T extends Int16Array | Uint8Array | Int8Array>(a: T, at: number, v: number): T {
  a[at] = v
  return a
}

describe('encodeValues / decodeValues', () => {
  it('round-trips Int16 (little-endian, negatives included), Uint8 and Int8', () => {
    const i16 = Int16Array.from([0, -1, 300, -32768, 32767])
    expect(decodeValues('i16', encodeValues(i16), 5)).toEqual(i16)
    const u8 = Uint8Array.from([0, 1, 255])
    expect(decodeValues('u8', encodeValues(u8), 3)).toEqual(u8)
    const i8 = Int8Array.from([-128, 0, 127])
    expect(decodeValues('i8', encodeValues(i8), 3)).toEqual(i8)
  })

  it('rejects data holding another number of values', () => {
    expect(() => decodeValues('u8', 'AAAA', 9)).toThrow('holds 3 values, expected 9')
    expect(() => decodeValues('i16', 'AAAAAA==', 4096)).toThrow('holds 2 values, expected 4096')
  })
})

describe('HeightLayer', () => {
  it('reads the delta in blocks (1/16 units) per column; 0 where unpainted', () => {
    const layer = new HeightLayer([{ x: 1, z: 0, values: filled(new Int16Array(HEIGHT_VALUES), 5 + 7 * 64, -24) }])
    expect(layer.at(64 + 5, 7)).toBe(-1.5)
    expect(layer.at(64 + 6, 7)).toBe(0)
    expect(layer.at(5, 7)).toBe(0)
  })

  it('replaces and removes tiles', () => {
    const layer = new HeightLayer()
    expect(layer.empty).toBe(true)
    layer.set(0, 0, filled(new Int16Array(HEIGHT_VALUES), 0, 16))
    expect(layer.at(0, 0)).toBe(1)
    layer.set(0, 0, new Int16Array(HEIGHT_VALUES)) // all zeros removes it
    expect(layer.empty).toBe(true)
  })
})

describe('BiomeLayer', () => {
  it('reads 4 × 4-column cells, -1 where unpainted', () => {
    const layer = new BiomeLayer([{ x: 0, z: 1, values: filled(new Uint8Array(BIOME_VALUES), 2 + 1 * 16, 3) }])
    expect(layer.at(8, 64 + 4)).toBe(2)
    expect(layer.at(11, 64 + 7)).toBe(2)
    expect(layer.at(12, 64 + 7)).toBe(-1)
    expect(layer.at(8, 4)).toBe(-1)
  })
})

describe('DensityLayer', () => {
  // sample (1, 1, 1) of brick (1, 0, 0) = block (18, 2, 2): +10 blocks
  const layer = new DensityLayer([{ x: 1, y: 0, z: 0, values: filled(new Int8Array(BRICK_VALUES), 1 + 1 * 8 + 1 * 64, 80) }])

  it('samples exactly on grid points and interpolates between them', () => {
    expect(layer.sample(18, 2, 2)).toBe(10)
    expect(layer.sample(19, 2, 2)).toBe(5)
    expect(layer.sample(17, 3, 2)).toBe(2.5)
    expect(layer.sample(100, 2, 2)).toBe(0)
    expect(layer.sample(0, 0, 0)).toBe(0)
  })

  it('reads 0 for samples at negative coordinates instead of colliding with another brick', () => {
    // Brick (-1, 1, 0) has key -1 + 1024 = 1023, the key of brick (1023, 0, 0).
    const far = new DensityLayer([{ x: 1023, y: 0, z: 0, values: new Int8Array(BRICK_VALUES).fill(80) }])
    expect(far.sample(-1, 20, 1)).toBe(0)
  })

  it('knows which columns it can touch, and follows replaced bricks', () => {
    expect(layer.touches(0, 0, 13, 40)).toBe(false)
    expect(layer.touches(0, 0, 14, 40)).toBe(true)
    expect(layer.touches(33, 0, 40, 40)).toBe(false)
    const l2 = new DensityLayer()
    expect(l2.empty).toBe(true)
    l2.set(2, 0, 0, filled(new Int8Array(BRICK_VALUES), 0, 8))
    expect(l2.touches(33, 0, 40, 40)).toBe(true)
    l2.set(2, 0, 0, null)
    expect(l2.touches(33, 0, 40, 40)).toBe(false)
  })
})

describe('checkLayers', () => {
  const tile = (v: number) => filled(new Int16Array(HEIGHT_VALUES), 0, v)
  function run(v: unknown) {
    const c = new Check()
    const out = checkLayers(c, 'layers', v, limits)
    return { errors: c.errors, out }
  }

  it('reads base64 tiles and decoded tiles alike: sorted by z then x, all-zero tiles dropped', () => {
    const a = tile(16), b = tile(-8), zero = new Int16Array(HEIGHT_VALUES)
    const json = run({ height: { tiles: [{ x: 1, z: 1, data: encodeValues(b) }, { x: 0, z: 1, data: encodeValues(a) }, { x: 1, z: 0, data: encodeValues(zero) }] } })
    const decoded = run({ height: { tiles: [{ x: 1, z: 1, values: b }, { x: 0, z: 1, values: a }, { x: 1, z: 0, values: zero }] } })
    expect(json.errors).toEqual([])
    expect(json.out).toEqual({ height: { tiles: [{ x: 0, z: 1, values: a }, { x: 1, z: 1, values: b }] } })
    expect(decoded.out).toEqual(json.out)
  })

  it('reports bad tiles with their paths', () => {
    const { errors } = run({
      height: { tiles: [{ x: 2, z: 0, data: encodeValues(tile(1)) }, { x: 0, z: 0, data: 'AAAAAA==' }, { x: 0, z: 1, values: new Uint8Array(4) }] },
      density: { bricks: [{ x: 0, y: 4, z: 0, data: encodeValues(new Int8Array(BRICK_VALUES)) }] },
      paint: {},
    })
    expect(errors).toEqual([
      'layers.paint: unknown layer (known: height, biome, density)',
      'layers.height.tiles[0].x: must be <= 1',
      'layers.height.tiles[1].data: holds 2 values, expected 4096',
      'layers.height.tiles[2].values: must be an Int16Array of 4096 values',
      'layers.density.bricks[0].y: must be <= 3',
    ])
  })

  it('rejects a duplicate tile', () => {
    expect(run({ height: { tiles: [{ x: 0, z: 0, values: tile(1) }, { x: 0, z: 0, values: tile(2) }] } }).errors)
      .toEqual(['layers.height.tiles[1]: duplicate tile (0, 0)'])
  })

  it('rejects the old full-raster format with a message that says so', () => {
    expect(run({ height: { width: 128, height: 128, type: 'i16', data: '' } }).errors)
      .toEqual(['layers.height: is a full raster (the old format); layers are now sparse: { tiles: [{ x, z, data }] }'])
  })

  it('rejects a biome value past the biome count', () => {
    const v = filled(new Uint8Array(BIOME_VALUES), 2 + 3 * 16, 3) // 2 biomes: 1..2 are valid
    expect(run({ biome: { tiles: [{ x: 0, z: 0, values: v }] } }).errors)
      .toEqual(['layers.biome.tiles[0]: value 3 at cell (2, 3) exceeds the 2 biomes'])
    v[2 + 3 * 16] = 2
    expect(run({ biome: { tiles: [{ x: 0, z: 0, values: v }] } }).errors).toEqual([])
  })

  it('accepts missing layers', () => {
    expect(run({})).toEqual({ errors: [], out: {} })
    expect(run(undefined)).toEqual({ errors: [], out: {} })
  })

  it('round-trips through layersToJSON', () => {
    const out = run({
      height: { tiles: [{ x: 0, z: 0, values: tile(-5) }] },
      biome: { tiles: [{ x: 1, z: 1, values: filled(new Uint8Array(BIOME_VALUES), 7, 2) }] },
      density: { bricks: [{ x: 1, y: 2, z: 3, values: filled(new Int8Array(BRICK_VALUES), 9, -100) }] },
    }).out
    expect(run(JSON.parse(JSON.stringify(layersToJSON(out)))).out).toEqual(out)
  })
})
