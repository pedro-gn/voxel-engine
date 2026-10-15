import type { BlockRegistry } from '../../blocks/registry.ts'
import { hexToLinear, type Rgb } from '../atmosphere.ts'

export const MAX_DECORATIONS = 16
export const MAX_BLADES = 24
export const MAX_FLOWER_COLORS = 8

/**
 * Where grass grows on its decorated tops: a world-space low-frequency noise in [0, 1], one cell every `scale` blocks.
 * Tops where it is below `threshold` stay bare; across ± `soft` around it the tufts thin out and shorten.
 */
export interface GrassCoverage { scale?: number; threshold?: number; soft?: number }
export interface GrassDef {
  blades?: number; height?: readonly [number, number]; base?: string; tip?: string; overhang?: number
  /** Blade width multiplier (default 1: blades 0.05–0.09 wide at the root); wider blades make fuller, softer tufts. (0, 4]. */
  width?: number
  /** Brightness variation between tufts (default 0.3: × 0.85–1.15). [0, 1]. */
  jitter?: number
  /** 0 pointed tips (default) … 1 blunt, rounded blades: the mid section widens and rises. [0, 1]. */
  blunt?: number
  /** How much darker the root is than the tip by occlusion (default 0.45: × 0.55 at the root). [0, 1]. */
  rootShade?: number
  /** Patchy coverage (default: every decorated top has grass). */
  coverage?: GrassCoverage
  /** How much the low-frequency patch noise thins and shortens tufts (default 1: down to 30 % of the blades); 0 keeps every tuft full. [0, 1]. */
  clump?: number
  /** A random rotation per tuft about its cell centre, as a fraction of a full turn (default 0: the 8 mirrored layouts); breaks the grain dense grass shows from afar. [0, 1]. */
  turn?: number
}
export interface FlowerDef { chance?: number; patchScale?: number; colors?: readonly string[] }
export interface DecorationDef { name: string; grass?: GrassDef; flowers?: FlowerDef; /** Instance density by the decorated block's state & 3 (e.g. grass youth: [1, ⅔, ⅓, 0]). Default all 1. */ stateDensity?: readonly [number, number, number, number] }

export function defineDecoration(def: DecorationDef): DecorationDef {
  return def
}

/** The style fields are present only when the definition sets them; `grassStyle` fills the defaults. */
export interface ResolvedGrass {
  blades: number; height: readonly [number, number]; base: Rgb; tip: Rgb; overhang: number
  width?: number; jitter?: number; blunt?: number; rootShade?: number; coverage?: Required<GrassCoverage>; clump?: number; turn?: number
}

/** Today's grass: the style an unset field keeps. */
export const GRASS_STYLE_DEFAULTS = { width: 1, jitter: 0.3, blunt: 0, rootShade: 0.45, coverage: { scale: 24, threshold: 0.35, soft: 0.1 }, clump: 1, turn: 0 } as const

/** Packed per decoration for the grass shader: shape (width, jitter, blunt, rootShade); cover (1 / scale, threshold, soft, clump); extra (turn, 0, 0, 0). */
export interface GrassStyle { shape: [number, number, number, number]; cover: [number, number, number, number]; extra: [number, number, number, number] }

export function grassStyle(g: ResolvedGrass | null): GrassStyle {
  const d = GRASS_STYLE_DEFAULTS
  const shape: GrassStyle['shape'] = [g?.width ?? d.width, g?.jitter ?? d.jitter, g?.blunt ?? d.blunt, g?.rootShade ?? d.rootShade]
  // Without coverage, a threshold below every noise value keeps the grass everywhere (soft stays > 0 for smoothstep).
  const c = g?.coverage, clump = g?.clump ?? d.clump
  return { shape, cover: c ? [1 / c.scale, c.threshold, c.soft, clump] : [0, -1, 0.5, clump], extra: [g?.turn ?? d.turn, 0, 0, 0] }
}
export interface ResolvedFlowers { chance: number; patchScale: number; colors: readonly Rgb[] }
export interface ResolvedDecoration { name: string; grass: ResolvedGrass | null; flowers: ResolvedFlowers | null; stateDensity: readonly number[] }

/** Plain typed arrays, posted to mesh workers in MeshTables. byBlock: 0 = none, k = decoration k − 1. */
export interface DecorationTables {
  byBlock: Uint8Array
  grass: Uint8Array
  flowerChance: Float32Array
  patchScale: Float32Array
  flowerColors: Uint8Array
  stateDensity: Float32Array
}

export function emptyDecorationTables(blockCount: number): DecorationTables {
  return { byBlock: new Uint8Array(blockCount), grass: new Uint8Array(0), flowerChance: new Float32Array(0), patchScale: new Float32Array(0), flowerColors: new Uint8Array(0), stateDensity: new Float32Array(0) }
}

const DEFAULT_FLOWER_COLORS = ['#e94b4b', '#f5d142', '#ffffff', '#f08ac0', '#6f8cf0']

function num(path: string, v: number | undefined, fallback: number, ok: (v: number) => boolean, rule: string): number {
  const x = v ?? fallback
  if (typeof x !== 'number' || !Number.isFinite(x) || !ok(x)) throw new RangeError(`${path} must be ${rule}, got ${String(x)}`)
  return x
}

function resolve(d: DecorationDef): ResolvedDecoration {
  const p = `decoration "${d.name}"`
  let grass: ResolvedGrass | null = null
  if (d.grass) {
    const g = d.grass
    const blades = num(`${p} grass.blades`, g.blades, 16, (v) => Number.isInteger(v) && v >= 1 && v <= MAX_BLADES, `an integer in [1, ${MAX_BLADES}]`)
    const [lo, hi] = g.height ?? [0.25, 0.55]
    if (!(Number.isFinite(lo) && Number.isFinite(hi) && lo >= 0.05 && lo <= hi && hi <= 2)) {
      throw new RangeError(`${p} grass.height must be [min, max] with 0.05 ≤ min ≤ max ≤ 2, got [${lo}, ${hi}]`)
    }
    grass = {
      blades,
      height: [lo, hi],
      base: hexToLinear(g.base ?? '#4f8a2e', `${p} grass.base`),
      tip: hexToLinear(g.tip ?? '#a9d65a', `${p} grass.tip`),
      overhang: num(`${p} grass.overhang`, g.overhang, 0.2, (v) => v >= 0 && v <= 0.5, 'in [0, 0.5]'),
    }
    const unit = (v: number) => v >= 0 && v <= 1
    if (g.width !== undefined) grass.width = num(`${p} grass.width`, g.width, 1, (v) => v > 0 && v <= 4, 'in (0, 4]')
    if (g.jitter !== undefined) grass.jitter = num(`${p} grass.jitter`, g.jitter, 0.3, unit, 'in [0, 1]')
    if (g.blunt !== undefined) grass.blunt = num(`${p} grass.blunt`, g.blunt, 0, unit, 'in [0, 1]')
    if (g.rootShade !== undefined) grass.rootShade = num(`${p} grass.rootShade`, g.rootShade, 0.45, unit, 'in [0, 1]')
    if (g.turn !== undefined) grass.turn = num(`${p} grass.turn`, g.turn, 0, unit, 'in [0, 1]')
    if (g.clump !== undefined) grass.clump = num(`${p} grass.clump`, g.clump, 1, unit, 'in [0, 1]')
    if (g.coverage !== undefined) {
      const c = g.coverage, d = GRASS_STYLE_DEFAULTS.coverage
      if (typeof c !== 'object' || c === null) throw new RangeError(`${p} grass.coverage must be an object`)
      grass.coverage = {
        scale: num(`${p} grass.coverage.scale`, c.scale, d.scale, (v) => v > 0, 'a finite number > 0'),
        threshold: num(`${p} grass.coverage.threshold`, c.threshold, d.threshold, unit, 'in [0, 1]'),
        soft: num(`${p} grass.coverage.soft`, c.soft, d.soft, (v) => v > 0 && v <= 0.5, 'in (0, 0.5]'),
      }
    }
  }
  let flowers: ResolvedFlowers | null = null
  if (d.flowers) {
    const f = d.flowers
    const colors = f.colors ?? DEFAULT_FLOWER_COLORS
    if (!Array.isArray(colors) || colors.length < 1 || colors.length > MAX_FLOWER_COLORS) {
      throw new RangeError(`${p} flowers.colors must list 1–${MAX_FLOWER_COLORS} colours`)
    }
    flowers = {
      chance: num(`${p} flowers.chance`, f.chance, 0.05, (v) => v >= 0 && v <= 1, 'in [0, 1]'),
      patchScale: num(`${p} flowers.patchScale`, f.patchScale, 12, (v) => v > 0, 'a finite number > 0'),
      colors: colors.map((c, i) => hexToLinear(c, `${p} flowers.colors[${i}]`)),
    }
  }
  const sd = d.stateDensity ?? [1, 1, 1, 1]
  if (!Array.isArray(sd) || sd.length !== 4 || !sd.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1)) {
    throw new RangeError(`${p} stateDensity must be 4 numbers in [0, 1]`)
  }
  return { name: d.name, grass, flowers, stateDensity: sd }
}

/** Main-thread registry of decorations; validates the blocks' `decoration` names (Deviation 9). */
export class DecorationRegistry {
  readonly defs: readonly ResolvedDecoration[]
  readonly tables: DecorationTables
  private readonly ids = new Map<string, number>()

  constructor(defs: readonly DecorationDef[], blocks: BlockRegistry) {
    if (defs.length > MAX_DECORATIONS) throw new RangeError(`too many decorations: ${defs.length} > ${MAX_DECORATIONS}`)
    this.defs = defs.map((d, i) => {
      if (typeof d.name !== 'string' || d.name.length === 0) throw new RangeError('decoration name must be a non-empty string')
      if (this.ids.has(d.name)) throw new Error(`duplicate decoration "${d.name}"`)
      this.ids.set(d.name, i)
      return resolve(d)
    })
    const byBlock = new Uint8Array(blocks.count)
    blocks.defs.forEach((b, id) => {
      if (b.decoration === undefined) return
      const k = this.ids.get(b.decoration)
      if (k === undefined) throw new Error(`block "${b.name}" names decoration "${b.decoration}", which is not defined`)
      byBlock[id] = k + 1
    })
    this.tables = {
      byBlock,
      grass: Uint8Array.from(this.defs, (d) => (d.grass ? 1 : 0)),
      flowerChance: Float32Array.from(this.defs, (d) => d.flowers?.chance ?? 0),
      patchScale: Float32Array.from(this.defs, (d) => d.flowers?.patchScale ?? 1),
      flowerColors: Uint8Array.from(this.defs, (d) => d.flowers?.colors.length ?? 0),
      stateDensity: Float32Array.from(this.defs.flatMap((d) => d.stateDensity)),
    }
  }

  id(name: string): number {
    const k = this.ids.get(name)
    if (k === undefined) throw new Error(`unknown decoration "${name}"`)
    return k
  }
}
