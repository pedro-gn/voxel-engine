import { describe, expect, it } from 'vitest'
import {
  AtmosphereController, DAY_KEYFRAMES, PRESETS, hexToLinear, lerpAngle, lerpAtmosphere, resolveAtmosphere, sunDirection, sunVisibility,
} from '../src/render/atmosphere.ts'

describe('colours', () => {
  it('converts sRGB hex to linear', () => {
    expect(hexToLinear('#ffffff')).toEqual([1, 1, 1])
    expect(hexToLinear('#000000')).toEqual([0, 0, 0])
    expect(hexToLinear('#808080')[0]).toBeCloseTo(0.2159, 3)
  })
  it('rejects malformed colours with the field path', () => {
    expect(() => hexToLinear('red', 'atmosphere.fog.color')).toThrow(/atmosphere\.fog\.color/)
    expect(() => hexToLinear('#12345')).toThrow(RangeError)
  })
})

describe('angles and the sun', () => {
  it('interpolates azimuth along the shortest arc', () => {
    expect(lerpAngle(350, 10, 0.5)).toBeCloseTo(0)
    expect(lerpAngle(10, 350, 0.5)).toBeCloseTo(0)
    expect(lerpAngle(90, 180, 0.5)).toBeCloseTo(135)
    expect(lerpAngle(350, 10, 0.25)).toBeCloseTo(355)
  })
  it('points the sun direction by azimuth and elevation', () => {
    const [x, y, z] = sunDirection(0, 0)
    expect([x, y, z].map((v) => +v.toFixed(6))).toEqual([1, 0, 0])
    expect(sunDirection(90, 0)[2]).toBeCloseTo(1)
    expect(sunDirection(0, 90)[1]).toBeCloseTo(1)
    const d = sunDirection(135, 50)
    expect(Math.hypot(...d)).toBeCloseTo(1)
  })
  it('turns the sun off at or below the horizon', () => {
    expect(sunVisibility(-10)).toBe(0)
    expect(sunVisibility(0)).toBe(0)
    expect(sunVisibility(2)).toBeCloseTo(0.5)
    expect(sunVisibility(30)).toBe(1)
  })
})

describe('resolveAtmosphere', () => {
  it('merges a partial input over a base', () => {
    const r = resolveAtmosphere(PRESETS.open, { fog: { far: 300 } })
    expect(r.fog.far).toBe(300)
    expect(r.fog.near).toBe(PRESETS.open.fog.near)
    expect(r.sun).toEqual(PRESETS.open.sun)
  })
  it('clamps ranged fields', () => {
    const r = resolveAtmosphere(PRESETS.open, { sky: { dome: 2, clouds: { coverage: -1 } }, sun: { elevation: 120 }, shadow: { strength: 3 } })
    expect(r.sky.dome).toBe(1)
    expect(r.sky.clouds.coverage).toBe(0)
    expect(r.sun.elevation).toBe(90)
    expect(r.shadow.strength).toBe(1)
  })
  it('normalises azimuth and keeps fog far beyond near', () => {
    const r = resolveAtmosphere(PRESETS.open, { sun: { azimuth: -90 }, fog: { near: 500, far: 100 } })
    expect(r.sun.azimuth).toBe(270)
    expect(r.fog.far).toBe(501)
  })
  it('rejects non-finite numbers, bad colours and unknown fields', () => {
    expect(() => resolveAtmosphere(PRESETS.open, { fog: { near: Number.NaN } })).toThrow(/atmosphere\.fog\.near/)
    expect(() => resolveAtmosphere(PRESETS.open, { sun: { intensity: Infinity } })).toThrow(RangeError)
    expect(() => resolveAtmosphere(PRESETS.open, { ambient: { sky: '#zzzzzz' } })).toThrow(/atmosphere\.ambient\.sky/)
    expect(() => resolveAtmosphere(PRESETS.open, { fog: { thickness: 2 } } as never)).toThrow(/unknown atmosphere field "atmosphere\.fog\.thickness"/)
  })
  it('ignores undefined fields', () => {
    expect(resolveAtmosphere(PRESETS.open, { fog: { near: undefined } })).toEqual(PRESETS.open)
  })
})

describe('lerpAtmosphere', () => {
  it('returns the ends at t = 0 and t = 1 and mixes in between', () => {
    expect(lerpAtmosphere(PRESETS.open, PRESETS.sunset, 0)).toEqual(PRESETS.open)
    expect(lerpAtmosphere(PRESETS.open, PRESETS.sunset, 1)).toEqual(PRESETS.sunset)
    const mid = lerpAtmosphere(PRESETS.open, PRESETS.sunset, 0.5)
    expect(mid.sun.elevation).toBeCloseTo((PRESETS.open.sun.elevation + PRESETS.sunset.sun.elevation) / 2)
    expect(mid.fog.color[0]).toBeCloseTo((PRESETS.open.fog.color[0] + PRESETS.sunset.fog.color[0]) / 2)
  })
})

describe('presets', () => {
  it('ships open, diorama and sunset with the diorama on a flat backdrop', () => {
    expect(Object.keys(PRESETS).sort()).toEqual(['diorama', 'open', 'sunset'])
    expect(PRESETS.diorama.sky.dome).toBe(0)
    expect(PRESETS.open.sky.dome).toBe(1)
    expect(PRESETS.sunset.sun.elevation).toBeLessThan(PRESETS.open.sun.elevation)
  })
  it('are deep-frozen, and set() still builds new values over them', () => {
    expect(Object.isFrozen(PRESETS.open.sun)).toBe(true)
    expect(Object.isFrozen(PRESETS.sunset.sky.clouds.light)).toBe(true)
    const c = new AtmosphereController()
    c.set({ sun: { elevation: 20 }, fog: { near: 950 } })
    expect(c.current.sun.elevation).toBe(20)
    expect(c.current.fog.far).toBe(951)
    expect(PRESETS.open.sun.elevation).toBe(50)
    expect(PRESETS.open.fog.near).toBe(140)
  })
})

describe('AtmosphereController', () => {
  it('starts on open and reports the first change once', () => {
    const c = new AtmosphereController()
    expect(c.current).toEqual(PRESETS.open)
    expect(c.update(0.016)).toBe(true)
    expect(c.update(0.016)).toBe(false)
  })
  it('applies a preset immediately without a duration', () => {
    const c = new AtmosphereController()
    c.set('sunset')
    expect(c.current).toEqual(PRESETS.sunset)
  })
  it('transitions over the duration with smoothstep easing', () => {
    const c = new AtmosphereController()
    c.update(0)
    c.set('sunset', { duration: 2 })
    const e0 = PRESETS.open.sun.elevation, e1 = PRESETS.sunset.sun.elevation
    expect(c.update(0.5)).toBe(true)
    expect(c.current.sun.elevation).toBeCloseTo(e0 + (e1 - e0) * 0.15625) // smoothstep(0.25)
    c.update(0.5)
    expect(c.current.sun.elevation).toBeCloseTo((e0 + e1) / 2)
    c.update(5)
    expect(c.current).toEqual(PRESETS.sunset)
    expect(c.update(0.1)).toBe(false)
  })
  it('starts a new transition from the current mixed state, never jumping', () => {
    const c = new AtmosphereController()
    c.set('sunset', { duration: 2 })
    c.update(1)
    const mid = c.current.sun.elevation
    c.set('open', { duration: 2 })
    c.update(1e-6)
    expect(c.current.sun.elevation).toBeCloseTo(mid, 3)
  })
  it('merges a partial set over the target, immediately and during a transition', () => {
    const c = new AtmosphereController()
    c.set({ fog: { far: 300 } })
    expect(c.current.fog.far).toBe(300)
    c.set('sunset', { duration: 2 })
    c.set({ fog: { far: 250 } })
    c.update(10)
    expect(c.current.fog.far).toBe(250)
    expect(c.current.sun.elevation).toBe(PRESETS.sunset.sun.elevation)
  })
  it('throws on unknown presets and bad input, leaving the state unchanged', () => {
    const c = new AtmosphereController()
    const before = c.current
    expect(() => c.set('noon')).toThrow(/unknown atmosphere preset "noon"/)
    expect(() => c.set({ fog: { near: Number.NaN } })).toThrow(RangeError)
    expect(() => c.set('sunset', { duration: -1 })).toThrow(/duration/)
    expect(c.current).toBe(before)
  })
  it('defines game presets over open', () => {
    const c = new AtmosphereController()
    c.define('night', { sun: { elevation: -10 }, ambient: { intensity: 0.15 } })
    expect(c.presetNames()).toContain('night')
    c.set('night')
    expect(c.current.sun.elevation).toBe(-10)
    expect(c.current.fog).toEqual(PRESETS.open.fog)
    expect(() => c.define('', {})).toThrow(/name/)
  })
})

describe('time of day', () => {
  it('interpolates the keyframes and wraps around midnight', () => {
    const a = new AtmosphereController()
    a.setTimeOfDay(0.5)
    expect(a.current.sun.elevation).toBeGreaterThan(45) // noon
    expect(a.update(0)).toBe(true)
    a.setTimeOfDay(0.99); const late = a.current.sun.azimuth
    a.setTimeOfDay(0.01); const early = a.current.sun.azimuth
    expect(Math.abs(((early - late + 540) % 360) - 180)).toBeLessThan(15) // no jump across midnight
    expect(a.timeOfDay).toBeCloseTo(0.01)
  })

  it('is dark but playable at night and bright at noon', () => {
    const a = new AtmosphereController()
    a.setTimeOfDay(0); const night = a.current
    a.setTimeOfDay(0.5); const noon = a.current
    expect(night.ambient.intensity).toBeGreaterThan(0.15)
    expect(night.ambient.intensity).toBeLessThan(noon.ambient.intensity)
    expect(night.sun.intensity).toBeLessThan(noon.sun.intensity)
  })

  it('a preset takes over again', () => {
    const a = new AtmosphereController()
    a.setTimeOfDay(0.3)
    a.set('sunset')
    expect(a.timeOfDay).toBeNull()
    expect(a.current).toEqual(PRESETS.sunset)
  })

  it('rejects bad times and bad keyframes', () => {
    const a = new AtmosphereController()
    expect(() => a.setTimeOfDay(1)).toThrow(RangeError)
    expect(() => a.setTimeOfDay(Number.NaN)).toThrow(RangeError)
    expect(() => a.defineDay([])).toThrow(RangeError)
    expect(() => a.defineDay([{ t: 0.5, atmosphere: {} }, { t: 0.2, atmosphere: {} }])).toThrow('keyframes must be sorted by t in [0, 1)')
  })
})

describe('day keyframes', () => {
  it('a custom day replaces the default', () => {
    const a = new AtmosphereController()
    a.defineDay([{ t: 0, atmosphere: { sun: { elevation: 10 } } }, { t: 0.5, atmosphere: { sun: { elevation: 50 } } }])
    a.setTimeOfDay(0.25)
    expect(a.current.sun.elevation).toBeCloseTo(30)
    expect(DAY_KEYFRAMES.length).toBeGreaterThan(4)
  })
})
