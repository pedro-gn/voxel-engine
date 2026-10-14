/** Linear-space RGB, 0–1 per channel. */
export type Rgb = readonly [number, number, number]

/** Every look parameter of the scene. Colours are linear RGB; angles are degrees. */
export interface Atmosphere {
  sun: { azimuth: number; elevation: number; color: Rgb; intensity: number }
  ambient: { sky: Rgb; ground: Rgb; intensity: number }
  sky: {
    dome: number
    zenith: Rgb
    horizon: Rgb
    sunGlow: number
    clouds: { coverage: number; scale: number; speed: number; light: Rgb; shade: Rgb }
  }
  fog: { color: Rgb; followHorizon: number; near: number; far: number; heightFalloff: number }
  shadow: { strength: number; tint: Rgb }
  grade: { exposure: number; saturation: number; contrast: number; highlights: Rgb; shadows: Rgb }
}

type InputOf<T> = { [K in keyof T]?: T[K] extends Rgb ? string : T[K] extends number ? number : InputOf<T[K]> }
/** A deep-partial Atmosphere; colours are '#rrggbb' sRGB strings. */
export type AtmosphereInput = InputOf<Atmosphere>

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function hexToLinear(hex: string, path = 'colour'): Rgb {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
    throw new RangeError(`${path} must be a "#rrggbb" colour, got ${JSON.stringify(hex)}`)
  }
  const n = Number.parseInt(hex.slice(1), 16)
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)]
}

/** [min, max] per numeric field path; fields not listed only need to be finite. */
const RANGES: Readonly<Record<string, readonly [number, number]>> = {
  'atmosphere.sun.elevation': [-90, 90],
  'atmosphere.sun.intensity': [0, Infinity],
  'atmosphere.ambient.intensity': [0, Infinity],
  'atmosphere.sky.dome': [0, 1],
  'atmosphere.sky.sunGlow': [0, Infinity],
  'atmosphere.sky.clouds.coverage': [0, 1],
  'atmosphere.sky.clouds.scale': [1, Infinity],
  'atmosphere.fog.followHorizon': [0, 1],
  'atmosphere.fog.near': [0, Infinity],
  'atmosphere.fog.far': [0, Infinity],
  'atmosphere.fog.heightFalloff': [0, Infinity],
  'atmosphere.shadow.strength': [0, 1],
  'atmosphere.grade.exposure': [0, Infinity],
  'atmosphere.grade.saturation': [0, Infinity],
  'atmosphere.grade.contrast': [0, Infinity],
}

function mergeNode(base: unknown, input: unknown, path: string): unknown {
  if (Array.isArray(base)) return hexToLinear(input as string, path)
  if (typeof base === 'number') {
    if (typeof input !== 'number' || !Number.isFinite(input)) throw new RangeError(`${path} must be a finite number, got ${String(input)}`)
    if (path === 'atmosphere.sun.azimuth') return ((input % 360) + 360) % 360
    const r = RANGES[path]
    return r ? Math.min(r[1], Math.max(r[0], input)) : input
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`${path} must be an object`)
  const b = base as Record<string, unknown>, i = input as Record<string, unknown>
  for (const k of Object.keys(i)) if (!(k in b)) throw new RangeError(`unknown atmosphere field "${path}.${k}"`)
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(b)) out[k] = i[k] === undefined ? b[k] : mergeNode(b[k], i[k], `${path}.${k}`)
  return out
}

/** Validates, clamps and merges `input` over `base`. Throws (naming the field) on bad input; never mutates. */
export function resolveAtmosphere(base: Atmosphere, input: AtmosphereInput): Atmosphere {
  const out = mergeNode(base, input, 'atmosphere') as Atmosphere
  // Unchanged sub-objects are shared with `base`, so copy before fixing up.
  if (out.fog.far < out.fog.near + 1) out.fog = { ...out.fog, far: out.fog.near + 1 }
  return out
}

export function lerpAngle(a: number, b: number, t: number): number {
  const d = ((((b - a) % 360) + 540) % 360) - 180
  return (((a + d * t) % 360) + 360) % 360
}

function lerpNode(a: unknown, b: unknown, t: number, key: string): unknown {
  if (Array.isArray(a)) return (a as number[]).map((v, i) => v + ((b as number[])[i]! - v) * t)
  if (typeof a === 'number') return key === 'azimuth' ? lerpAngle(a, b as number, t) : a + ((b as number) - a) * t
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(a as object)) out[k] = lerpNode((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], t, k)
  return out
}

export function lerpAtmosphere(a: Atmosphere, b: Atmosphere, t: number): Atmosphere {
  if (t <= 0) return a
  if (t >= 1) return b
  return lerpNode(a, b, t, '') as Atmosphere
}

const RAD = Math.PI / 180

/** Unit vector towards the sun. Azimuth 0 → +x, 90 → +z; elevation 90 → straight up. */
export function sunDirection(azimuth: number, elevation: number): [number, number, number] {
  const az = azimuth * RAD, el = elevation * RAD
  return [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)]
}

/** 0 at or below the horizon, ramping to 1 at 4° of elevation. */
export function sunVisibility(elevation: number): number {
  return Math.min(1, Math.max(0, elevation / 4))
}

const BLACK: Rgb = [0, 0, 0]
const TEMPLATE: Atmosphere = {
  sun: { azimuth: 0, elevation: 45, color: BLACK, intensity: 1 },
  ambient: { sky: BLACK, ground: BLACK, intensity: 1 },
  sky: { dome: 1, zenith: BLACK, horizon: BLACK, sunGlow: 0, clouds: { coverage: 0, scale: 400, speed: 0, light: BLACK, shade: BLACK } },
  fog: { color: BLACK, followHorizon: 0, near: 0, far: 1, heightFalloff: 0 },
  shadow: { strength: 1, tint: BLACK },
  grade: { exposure: 1, saturation: 1, contrast: 1, highlights: BLACK, shadows: BLACK },
}

// Values are first guesses, tuned at the visual checkpoints (spec §3).
const OPEN = resolveAtmosphere(TEMPLATE, {
  sun: { azimuth: 135, elevation: 50, color: '#fff1d6', intensity: 1.6 },
  ambient: { sky: '#a8c8ff', ground: '#6b5a45', intensity: 0.7 },
  sky: {
    dome: 1, zenith: '#2f6fd6', horizon: '#bcd9f2', sunGlow: 0.6,
    clouds: { coverage: 0.45, scale: 420, speed: 4, light: '#ffffff', shade: '#b7c6dc' },
  },
  fog: { color: '#bcd9f2', followHorizon: 1, near: 140, far: 900, heightFalloff: 0.012 },
  shadow: { strength: 0.85, tint: '#5b6b99' },
  grade: { exposure: 1, saturation: 1.0, contrast: 1.05, highlights: '#fff6e8', shadows: '#e8eeff' },
})

/** Freezes `o` and everything reachable from it, so a caller can't corrupt a shared preset through `current`. */
function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v)
    Object.freeze(o)
  }
  return o
}

export const PRESETS: Readonly<Record<'open' | 'diorama' | 'sunset', Atmosphere>> = deepFreeze({
  open: OPEN,
  diorama: resolveAtmosphere(OPEN, {
    sun: { azimuth: 215, elevation: 55, intensity: 1.5 },
    sky: { dome: 0, zenith: '#cfd8e0', horizon: '#e6ebef' },
    fog: { followHorizon: 0, color: '#e6ebef', near: 700, far: 2400 },
    shadow: { strength: 0.75 },
  }),
  sunset: resolveAtmosphere(OPEN, {
    sun: { azimuth: 250, elevation: 9, color: '#ffb27a', intensity: 1.3 },
    ambient: { sky: '#d9a6c8', ground: '#5a4050', intensity: 0.6 },
    sky: { zenith: '#6a5aa8', horizon: '#ff9fb0', sunGlow: 1.2, clouds: { light: '#ffd1b0', shade: '#a9779a' } },
    fog: { color: '#f2a5a8', near: 90, far: 650 },
    shadow: { tint: '#6a4f7a' },
    grade: { highlights: '#ffe2c8', shadows: '#e6dcff' },
  }),
})

/** One keyframe of a day: the look at time `t` (0 midnight, 0.5 noon), resolved over the 'open' preset. */
export interface DayKey { t: number; atmosphere: AtmosphereInput }

/** The default day (first guesses, tuned at the checkpoints): t 0 is midnight, 0.25 sunrise, 0.5 noon, 0.75 sunset. The night "sun" is the moon. */
export const DAY_KEYFRAMES: readonly DayKey[] = deepFreeze([
  { t: 0.0, atmosphere: { sun: { azimuth: 0, elevation: 40, color: '#9fb4ff', intensity: 0.25 }, ambient: { sky: '#3a4a7a', ground: '#1e1a24', intensity: 0.3 }, sky: { zenith: '#0b1530', horizon: '#26345e', sunGlow: 0.05, clouds: { light: '#4a5680', shade: '#20263f' } }, fog: { color: '#1d2747' }, shadow: { strength: 0.5, tint: '#1a2140' }, grade: { exposure: 0.9 } } },
  { t: 0.2, atmosphere: { sun: { azimuth: 60, elevation: -8, color: '#9fb4ff', intensity: 0.2 }, ambient: { sky: '#4a5590', ground: '#2a2230', intensity: 0.32 }, sky: { zenith: '#1a2550', horizon: '#6a5a8a', sunGlow: 0.1 }, fog: { color: '#4a4a74' } } },
  { t: 0.25, atmosphere: { sun: { azimuth: 90, elevation: 2, color: '#ffb27a', intensity: 1.1 }, ambient: { sky: '#d9a6c8', ground: '#5a4050', intensity: 0.5 }, sky: { zenith: '#5a6ab0', horizon: '#ffa98a', sunGlow: 1.2 }, fog: { color: '#f2b0a0' } } },
  { t: 0.32, atmosphere: { sun: { azimuth: 110, elevation: 30, color: '#fff1d6', intensity: 1.5 }, ambient: { sky: '#a8c8ff', ground: '#6b5a45', intensity: 0.65 } } },
  { t: 0.5, atmosphere: { sun: { azimuth: 180, elevation: 62, color: '#fff6e8', intensity: 1.7 }, ambient: { sky: '#a8c8ff', ground: '#6b5a45', intensity: 0.75 }, sky: { zenith: '#2f6fd6', horizon: '#bcd9f2', sunGlow: 0.6 }, fog: { color: '#bcd9f2' } } },
  { t: 0.68, atmosphere: { sun: { azimuth: 250, elevation: 30, color: '#fff1d6', intensity: 1.5 }, ambient: { intensity: 0.65 } } },
  { t: 0.75, atmosphere: { sun: { azimuth: 270, elevation: 2, color: '#ffb27a', intensity: 1.2 }, ambient: { sky: '#d9a6c8', ground: '#5a4050', intensity: 0.5 }, sky: { zenith: '#6a5aa8', horizon: '#ff9fb0', sunGlow: 1.2 }, fog: { color: '#f2a5a8' } } },
  { t: 0.8, atmosphere: { sun: { azimuth: 300, elevation: -8, color: '#9fb4ff', intensity: 0.2 }, ambient: { sky: '#4a5590', ground: '#2a2230', intensity: 0.32 }, sky: { zenith: '#1a2550', horizon: '#5a4a7a', sunGlow: 0.1 }, fog: { color: '#3a3a64' } } },
])

const ease = (t: number) => t * t * (3 - 2 * t)
const resolveDay = (keys: readonly DayKey[]) => keys.map(k => ({ t: k.t, a: resolveAtmosphere(OPEN, k.atmosphere) }))

/** Holds the scene's atmosphere and its preset transitions. Advanced once per rendered frame. */
export class AtmosphereController {
  private readonly presets = new Map<string, Atmosphere>(Object.entries(PRESETS))
  private from: Atmosphere
  private to: Atmosphere
  private now: Atmosphere
  private elapsed = 0
  private duration = 0
  private changed = true
  /** The day's keyframes, resolved (DAY_KEYFRAMES unless defineDay replaced them). */
  private day: { t: number; a: Atmosphere }[] = resolveDay(DAY_KEYFRAMES)
  private tod: number | null = null

  constructor(initial = 'open') {
    const p = this.preset(initial)
    this.from = p
    this.to = p
    this.now = p
  }

  /** Resolved values. Treat as read-only. */
  get current(): Atmosphere { return this.now }

  presetNames(): string[] { return [...this.presets.keys()] }

  /** The time of day last set (spec §6); null while a preset or an explicit look is in force. */
  get timeOfDay(): number | null { return this.tod }

  /** Replaces the day's keyframes: at least one, sorted by t in [0, 1); the day wraps from the last back to the first. */
  defineDay(keys: readonly DayKey[]): void {
    if (!Array.isArray(keys) || !keys.length || keys.some((k, i) => !(k.t >= 0 && k.t < 1) || (i > 0 && k.t <= keys[i - 1]!.t))) throw new RangeError('keyframes must be sorted by t in [0, 1)')
    this.day = resolveDay(keys)
  }

  /** Sets the look from the day's keyframes (t in [0, 1): 0 midnight, 0.25 sunrise, 0.5 noon); a preset set later takes over again. */
  setTimeOfDay(t: number): void {
    if (!(t >= 0 && t < 1)) throw new RangeError(`time of day must be in [0, 1), got ${t}`)
    const d = this.day, n = d.length
    let i = n - 1
    while (i > 0 && d[i]!.t > t) i--
    if (d[0]!.t > t) i = n - 1
    const a = d[i]!, b = d[(i + 1) % n]!
    const span = ((b.t - a.t + 1) % 1) || 1
    const f = ((t - a.t + 1) % 1) / span
    this.now = lerpAtmosphere(a.a, b.a, f); this.from = this.now; this.to = this.now; this.duration = 0; this.elapsed = 0
    this.tod = t; this.changed = true
  }

  set(target: string | AtmosphereInput, options: { duration?: number } = {}): void {
    this.tod = null
    const duration = options.duration ?? 0
    if (!Number.isFinite(duration) || duration < 0) throw new RangeError(`duration must be a finite number ≥ 0, got ${duration}`)
    if (typeof target === 'string') {
      const next = this.preset(target)
      if (duration === 0) {
        this.from = next; this.to = next; this.now = next; this.duration = 0; this.elapsed = 0
      } else {
        this.from = this.now; this.to = next; this.duration = duration; this.elapsed = 0
      }
    } else if (duration === 0) {
      const to = resolveAtmosphere(this.to, target)
      const from = resolveAtmosphere(this.from, target)
      this.to = to
      this.from = from
      this.now = this.duration > 0 ? lerpAtmosphere(from, to, ease(this.elapsed / this.duration)) : to
    } else {
      const to = resolveAtmosphere(this.to, target)
      this.from = this.now; this.to = to; this.duration = duration; this.elapsed = 0
    }
    this.changed = true
  }

  define(name: string, input: AtmosphereInput): void {
    if (typeof name !== 'string' || name.length === 0) throw new RangeError('atmosphere preset name must be a non-empty string')
    this.presets.set(name, resolveAtmosphere(OPEN, input))
  }

  update(dt: number): boolean {
    if (this.duration > 0 && Number.isFinite(dt) && dt > 0) {
      this.elapsed = Math.min(this.duration, this.elapsed + dt)
      if (this.elapsed >= this.duration) {
        this.now = this.to; this.from = this.to; this.duration = 0; this.elapsed = 0
      } else {
        this.now = lerpAtmosphere(this.from, this.to, ease(this.elapsed / this.duration))
      }
      this.changed = true
    }
    const c = this.changed
    this.changed = false
    return c
  }

  private preset(name: string): Atmosphere {
    const p = this.presets.get(name)
    if (!p) throw new RangeError(`unknown atmosphere preset "${name}" (known: ${[...this.presets.keys()].join(', ')})`)
    return p
  }
}
