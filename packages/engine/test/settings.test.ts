import { describe, expect, it } from 'vitest'
import { hexToLinear } from '../src/render/atmosphere.ts'
import { DEFAULT_EFFECTS, DEFAULT_QUALITY, DEFAULT_WATER, mergeEffects, mergeQuality, mergeWater, resolveEffects } from '../src/render/settings.ts'

describe('quality', () => {
  it('has the spec defaults', () => {
    expect(DEFAULT_QUALITY).toEqual({ shadowMapSize: 2048, decorationRadius: 96, decorationMaxInstances: 400_000, msaa: 4 })
  })
  it('merges a partial update', () => {
    expect(mergeQuality(DEFAULT_QUALITY, { shadowMapSize: 4096 })).toEqual({ ...DEFAULT_QUALITY, shadowMapSize: 4096 })
    expect(mergeQuality(DEFAULT_QUALITY, { msaa: 0, decorationRadius: undefined })).toEqual({ ...DEFAULT_QUALITY, msaa: 0 })
  })
  it('rejects bad values with the field name and keeps the input untouched', () => {
    expect(() => mergeQuality(DEFAULT_QUALITY, { shadowMapSize: 1000 })).toThrow(/quality\.shadowMapSize/)
    expect(() => mergeQuality(DEFAULT_QUALITY, { shadowMapSize: 16384 })).toThrow(RangeError)
    expect(() => mergeQuality(DEFAULT_QUALITY, { decorationRadius: 0 })).toThrow(/quality\.decorationRadius/)
    expect(() => mergeQuality(DEFAULT_QUALITY, { decorationRadius: Number.NaN })).toThrow(RangeError)
    expect(() => mergeQuality(DEFAULT_QUALITY, { decorationMaxInstances: 1.5 })).toThrow(/decorationMaxInstances/)
    expect(() => mergeQuality(DEFAULT_QUALITY, { msaa: 2 })).toThrow(/quality\.msaa/)
    expect(() => mergeQuality(DEFAULT_QUALITY, { lod: 1 } as never)).toThrow(/unknown quality field "lod"/)
    expect(DEFAULT_QUALITY.shadowMapSize).toBe(2048)
  })
})

describe('effects', () => {
  it('defaults everything on and merges booleans', () => {
    expect(DEFAULT_EFFECTS).toEqual({ shadows: true, decorations: true, water: true, post: true, fog: true })
    expect(mergeEffects(DEFAULT_EFFECTS, { fog: false })).toEqual({ ...DEFAULT_EFFECTS, fog: false })
  })
  it('rejects non-booleans and unknown keys', () => {
    expect(() => mergeEffects(DEFAULT_EFFECTS, { fog: 0 as never })).toThrow(/effects\.fog/)
    expect(() => mergeEffects(DEFAULT_EFFECTS, { bloom: true } as never)).toThrow(/unknown effects field "bloom"/)
  })
  it('turns off what the backend cannot do, with one warning each', () => {
    const r = resolveEffects(DEFAULT_EFFECTS, { shadows: false, waterDepth: false })
    expect(r.effects.shadows).toBe(false)
    expect(r.waterDepth).toBe(false)
    expect(r.warnings).toHaveLength(2)
    expect(r.warnings.join(' ')).toMatch(/shadows/)
    expect(r.warnings.join(' ')).toMatch(/water/)
  })
  it('passes requests through on a capable backend', () => {
    const r = resolveEffects({ ...DEFAULT_EFFECTS, shadows: false }, { shadows: true, waterDepth: true })
    expect(r).toEqual({ effects: { ...DEFAULT_EFFECTS, shadows: false }, waterDepth: true, warnings: [] })
  })
})

describe('water params', () => {
  it('has turquoise-to-blue defaults', () => {
    expect(DEFAULT_WATER.shallow).toEqual(hexToLinear('#5fd0d6'))
    expect(DEFAULT_WATER.deep).toEqual(hexToLinear('#1f6fae'))
  })
  it('merges colours and numbers', () => {
    const w = mergeWater(DEFAULT_WATER, { shallow: '#ffffff', foamWidth: 0.5 })
    expect(w.shallow).toEqual([1, 1, 1])
    expect(w.foamWidth).toBe(0.5)
    expect(w.deep).toEqual(DEFAULT_WATER.deep)
  })
  it('rejects bad values with the field name', () => {
    expect(() => mergeWater(DEFAULT_WATER, { deep: 'blue' })).toThrow(/water\.deep/)
    expect(() => mergeWater(DEFAULT_WATER, { depthScale: 0 })).toThrow(/water\.depthScale/)
    expect(() => mergeWater(DEFAULT_WATER, { foamWidth: -1 })).toThrow(/water\.foamWidth/)
    expect(() => mergeWater(DEFAULT_WATER, { waveSpeed: Number.NaN })).toThrow(/water\.waveSpeed/)
    expect(() => mergeWater(DEFAULT_WATER, { colour: '#fff' } as never)).toThrow(/unknown water field "colour"/)
    expect(() => mergeWater(DEFAULT_WATER, { waveScale: 0 })).toThrow(/water\.waveScale/)
    expect(() => mergeWater(DEFAULT_WATER, { waveScale: -1 })).toThrow(/water\.waveScale/)
  })
  it('accepts foamWidth 0 as "foam off"', () => {
    expect(mergeWater(DEFAULT_WATER, { foamWidth: 0 }).foamWidth).toBe(0)
  })
  it('leaves its cur argument unchanged', () => {
    const cur = { ...DEFAULT_WATER } // an unfrozen copy, so a mutation would not throw
    const before = structuredClone(cur)
    mergeWater(cur, { shallow: '#ffffff', foamWidth: 1, waveScale: 2 })
    expect(cur).toEqual(before)
  })
})
