import { hexToLinear, type Rgb } from './atmosphere.ts'

export type Backend = 'webgpu' | 'webgl'

export interface Quality {
  /** Sun shadow map resolution: a power of two in [256, 8192]. */
  shadowMapSize: number
  /** Blocks from the camera beyond which grass and flowers have shrunk away. */
  decorationRadius: number
  /** Ceiling on visible decoration instances; the nearest chunks win. */
  decorationMaxInstances: number
  /** Post-pipeline MSAA samples: 0 (off) or 4. */
  msaa: number
}
export const DEFAULT_QUALITY: Quality = Object.freeze({ shadowMapSize: 2048, decorationRadius: 96, decorationMaxInstances: 400_000, msaa: 4 })

export interface Effects { shadows: boolean; decorations: boolean; water: boolean; post: boolean; fog: boolean }
export const DEFAULT_EFFECTS: Effects = Object.freeze({ shadows: true, decorations: true, water: true, post: true, fog: true })

export interface Support { shadows: boolean; waterDepth: boolean }
/** What each backend can do, from the Task 1 spike (see "Spike results" in the plan). */
export const SUPPORT: Readonly<Record<Backend, Support>> = Object.freeze({
  webgpu: { shadows: true, waterDepth: true },
  webgl: { shadows: true, waterDepth: true },
})

function checked<T extends object>(name: string, cur: T, input: Partial<T>): Partial<T> {
  if (input === null || typeof input !== 'object') throw new TypeError(`${name} must be an object`)
  const out: Partial<T> = {}
  for (const k of Object.keys(input) as (keyof T & string)[]) {
    if (!(k in cur)) throw new RangeError(`unknown ${name} field "${k}"`)
    if (input[k] !== undefined) out[k] = input[k]
  }
  return out
}

const isPow2 = (n: number) => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0

export function mergeQuality(cur: Quality, input: Partial<Quality>): Quality {
  const q = { ...cur, ...checked('quality', cur, input) }
  if (!isPow2(q.shadowMapSize) || q.shadowMapSize < 256 || q.shadowMapSize > 8192) {
    throw new RangeError(`quality.shadowMapSize must be a power of two in [256, 8192], got ${q.shadowMapSize}`)
  }
  if (!Number.isFinite(q.decorationRadius) || q.decorationRadius <= 0 || q.decorationRadius > 512) {
    throw new RangeError(`quality.decorationRadius must be in (0, 512], got ${q.decorationRadius}`)
  }
  if (!Number.isInteger(q.decorationMaxInstances) || q.decorationMaxInstances < 0) {
    throw new RangeError(`quality.decorationMaxInstances must be a non-negative integer, got ${q.decorationMaxInstances}`)
  }
  if (q.msaa !== 0 && q.msaa !== 4) throw new RangeError(`quality.msaa must be 0 or 4, got ${q.msaa}`)
  return Object.freeze(q)
}

export function mergeEffects(cur: Effects, input: Partial<Effects>): Effects {
  const patch = checked('effects', cur, input)
  for (const [k, v] of Object.entries(patch)) if (typeof v !== 'boolean') throw new TypeError(`effects.${k} must be a boolean, got ${String(v)}`)
  return Object.freeze({ ...cur, ...patch })
}

export function resolveEffects(requested: Effects, support: Support): { effects: Effects; waterDepth: boolean; warnings: string[] } {
  const warnings: string[] = []
  let effects = requested
  if (requested.shadows && !support.shadows) {
    effects = { ...effects, shadows: false }
    warnings.push('shadows are not supported on this backend; they are disabled')
  }
  if (!support.waterDepth) warnings.push('water depth effects (shore foam, depth colour) are not supported on this backend; water renders without them')
  return { effects, waterDepth: support.waterDepth, warnings }
}

export interface WaterParams { shallow: Rgb; deep: Rgb; depthScale: number; foamWidth: number; waveScale: number; waveSpeed: number }
export interface WaterInput { shallow?: string; deep?: string; depthScale?: number; foamWidth?: number; waveScale?: number; waveSpeed?: number }

export const DEFAULT_WATER: WaterParams = Object.freeze({
  shallow: hexToLinear('#5fd0d6'), deep: hexToLinear('#1f6fae'), depthScale: 3, foamWidth: 0.35, waveScale: 0.35, waveSpeed: 0.6,
})

export function mergeWater(cur: WaterParams, input: WaterInput): WaterParams {
  const patch = checked('water', cur as unknown as Required<WaterInput>, input)
  const out: WaterParams = { ...cur }
  if (patch.shallow !== undefined) out.shallow = hexToLinear(patch.shallow, 'water.shallow')
  if (patch.deep !== undefined) out.deep = hexToLinear(patch.deep, 'water.deep')
  const num = (k: 'depthScale' | 'foamWidth' | 'waveScale' | 'waveSpeed', ok: (v: number) => boolean, rule: string) => {
    const v = patch[k]
    if (v === undefined) return
    if (typeof v !== 'number' || !Number.isFinite(v) || !ok(v)) throw new RangeError(`water.${k} must be ${rule}, got ${String(v)}`)
    out[k] = v
  }
  num('depthScale', (v) => v > 0, 'a finite number > 0')
  num('foamWidth', (v) => v >= 0, 'a finite number ≥ 0')
  num('waveScale', (v) => v > 0, 'a finite number > 0')
  num('waveSpeed', () => true, 'a finite number')
  return Object.freeze(out)
}
