import type { BlockRegistry } from '../../blocks/registry.ts'
import { hexToLinear, type Rgb } from '../atmosphere.ts'

export const MAX_DECORATIONS = 16
export const MAX_BLADES = 24
export const MAX_FLOWER_COLORS = 8

export interface GrassDef { blades?: number; height?: readonly [number, number]; base?: string; tip?: string; overhang?: number }
export interface FlowerDef { chance?: number; patchScale?: number; colors?: readonly string[] }
export interface DecorationDef { name: string; grass?: GrassDef; flowers?: FlowerDef; /** Instance density by the decorated block's state & 3 (e.g. grass youth: [1, ⅔, ⅓, 0]). Default all 1. */ stateDensity?: readonly [number, number, number, number] }

export function defineDecoration(def: DecorationDef): DecorationDef {
  return def
}

export interface ResolvedGrass { blades: number; height: readonly [number, number]; base: Rgb; tip: Rgb; overhang: number }
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
