import { describe, expect, it } from 'vitest'
import { DecorationRegistry } from '../src/render/decorations/defs.ts'
import { createDecorationMaterials } from '../src/render/decorations/material.ts'
import { WindMask, createDecorationWind, windAmplitude } from '../src/render/decorations/windMask.ts'
import { createLightUniforms } from '../src/render/voxelLighting.ts'
import { testRegistry } from './helpers.ts'

describe('decoration wind', () => {
  it('amplitude grows with strength and exposure', () => {
    expect(windAmplitude(0, 1)).toBe(0.25)
    expect(windAmplitude(1, 1)).toBeCloseTo(1.35, 10)
    expect(windAmplitude(1, 0)).toBe(0.25)
    expect(windAmplitude(0.5, 1)).toBeGreaterThan(windAmplitude(0.35, 1))
    expect(windAmplitude(0.5, 1)).toBeGreaterThan(windAmplitude(0.5, 0.5))
  })

  it('defaults: a gentle breeze over an all-exposed mask', () => {
    const wind = createDecorationWind(new WindMask(4, 4))
    const d = Math.hypot(1, 0.3)
    expect(wind.dir.value.x).toBeCloseTo(1 / d, 6)
    expect(wind.dir.value.y).toBeCloseTo(0.3 / d, 6)
    expect(wind.strength.value).toBeCloseTo(0.35, 6)
    expect(wind.mask.data.every(v => v === 255)).toBe(true)
  })

  it('createDecorationMaterials takes wind inputs', () => {
    const mask = new WindMask(4, 4)
    const wind = createDecorationWind(mask)
    const dm = createDecorationMaterials(new DecorationRegistry([], testRegistry()), createLightUniforms(), undefined, wind)
    expect(dm.wind).toBe(wind)
    expect(dm.grass.positionNode).toBeTruthy()
    expect(dm.flowers.positionNode).toBeTruthy()
    expect(typeof mask.onChange).toBe('function') // the material re-uploads the mask texture
    wind.set({ dirX: 0, dirZ: 2, strength: 0.8 })
    expect(wind.dir.value.x).toBeCloseTo(0, 10)
    expect(wind.dir.value.y).toBeCloseTo(1, 10)
    expect(wind.strength.value).toBeCloseTo(0.8, 6)
  })

  it('a zero direction keeps the last one; bad numbers throw', () => {
    const wind = createDecorationWind(new WindMask(1, 4))
    wind.set({ dirX: -3, dirZ: 0, strength: 0.1 })
    wind.set({ dirX: 0, dirZ: 0, strength: 0.2 })
    expect(wind.dir.value.x).toBeCloseTo(-1, 10)
    expect(wind.dir.value.y).toBeCloseTo(0, 10)
    expect(wind.strength.value).toBeCloseTo(0.2, 6)
    expect(() => wind.set({ dirX: Number.NaN, dirZ: 1, strength: 0.5 })).toThrow(RangeError)
    expect(() => wind.set({ dirX: 1, dirZ: 0, strength: -0.1 })).toThrow(RangeError)
    expect(() => wind.set({ dirX: 1, dirZ: 0, strength: Number.POSITIVE_INFINITY })).toThrow(RangeError)
    expect(wind.strength.value).toBeCloseTo(0.2, 6)
  })

  it('materials without wind inputs still build (today\'s callers)', () => {
    const dm = createDecorationMaterials(new DecorationRegistry([], testRegistry()), createLightUniforms())
    expect(dm.wind.mask.data.every(v => v === 255)).toBe(true)
  })
})
