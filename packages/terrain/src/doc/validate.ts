import { checkLayers } from '../layers/tiles.ts'
import { builtinOps } from '../ops/builtin.ts'
import type { OpRegistry } from '../ops/registry.ts'
import { checkShape } from '../shapes/shape.ts'
import { Check, checkNoise } from './check.ts'
import {
  BLEND_MODES, DEFAULT_BLOCKS, TREE_KINDS,
  type BlendMode, type BlockNames, type OpDef, type ShapeDef, type TerrainDoc,
} from './types.ts'

export const TERRAIN_FORMAT = 'elovox-terrain'
export const TERRAIN_VERSION = 1

export type ValidateResult = { ok: true; doc: TerrainDoc } | { ok: false; errors: string[] }

export interface ValidateOptions {
  /** Op types the document may use. Default: the built-in ops. */
  ops?: OpRegistry
  /** World height, for y ranges. Default 128. */
  worldHeight?: number
}

export class TerrainDocError extends Error {
  readonly errors: readonly string[]
  constructor(errors: readonly string[]) {
    super(`invalid terrain document:\n  - ${errors.join('\n  - ')}`)
    this.name = 'TerrainDocError'
    this.errors = errors
  }
}

/**
 * Checks a parsed JSON value against the TerrainDoc format and returns it normalized (defaults
 * filled in), or every error found, each prefixed with its path.
 */
export function validateTerrainDoc(json: unknown, o: ValidateOptions = {}): ValidateResult {
  const ops = o.ops ?? builtinOps
  const height = o.worldHeight ?? 128
  const c = new Check()
  if (!c.obj('(document)', json)) return { ok: false, errors: c.errors }
  const d = json

  if (d.format !== TERRAIN_FORMAT) c.fail('format', `must be "${TERRAIN_FORMAT}"`)
  if (d.version !== TERRAIN_VERSION) c.fail('version', `unsupported version ${JSON.stringify(d.version)} (this build reads version ${TERRAIN_VERSION})`)
  if (c.vec2('size', d.size)) {
    d.size.forEach((s, i) => {
      if (!Number.isInteger(s) || s <= 0 || s % 32 !== 0) c.fail(`size[${i}]`, 'must be a positive multiple of 32')
    })
  }
  c.num('seaLevel', d.seaLevel, { int: true, min: 0, max: height - 1 })
  if (c.obj('blocks', d.blocks, true)) {
    for (const [k, v] of Object.entries(d.blocks)) {
      if (!(k in DEFAULT_BLOCKS)) c.fail(`blocks.${k}`, `unknown key (known: ${Object.keys(DEFAULT_BLOCKS).join(', ')})`)
      else c.str(`blocks.${k}`, v)
    }
  }
  if (c.obj('base', d.base)) {
    c.num('base.height', d.base.height, { min: 0, max: height })
    c.num('base.amplitude', d.base.amplitude, { min: 0 })
    checkNoise(c, 'base.noise', d.base.noise)
  }

  const biomeNames: string[] = []
  if (c.arr('biomes', d.biomes, 1)) {
    d.biomes.forEach((b, i) => {
      const p = `biomes[${i}]`
      if (!c.obj(p, b)) return
      if (c.str(`${p}.name`, b.name)) {
        if (biomeNames.includes(b.name)) c.fail(`${p}.name`, `duplicate biome "${b.name}"`)
        else biomeNames.push(b.name)
      }
      if (c.arr(`${p}.surface`, b.surface)) b.surface.forEach((r, j) => checkRule(c, `${p}.surface[${j}]`, r))
      if (c.obj(`${p}.trees`, b.trees, true)) {
        c.num(`${p}.trees.density`, b.trees.density, { min: 0, max: 1 })
        if (c.arr(`${p}.trees.kinds`, b.trees.kinds, 1)) b.trees.kinds.forEach((k, j) => c.str(`${p}.trees.kinds[${j}]`, k, TREE_KINDS))
        if (c.arr(`${p}.trees.on`, b.trees.on, 1, true)) b.trees.on.forEach((k, j) => c.str(`${p}.trees.on[${j}]`, k))
      }
      if (c.obj(`${p}.rocks`, b.rocks, true)) {
        c.num(`${p}.rocks.density`, b.rocks.density, { min: 0, max: 1 })
        if (c.range(`${p}.rocks.size`, b.rocks.size) && (b.rocks.size[0] < 1 || b.rocks.size[1] > 6)) c.fail(`${p}.rocks.size`, 'must be within [1, 6]')
      }
    })
  }

  if (c.obj('biomeRule', d.biomeRule)) {
    const r = d.biomeRule
    c.str('biomeRule.default', r.default, biomeNames)
    checkNoise(c, 'biomeRule.moisture', r.moisture, true)
    if (c.arr('biomeRule.rules', r.rules, 0, true)) {
      r.rules.forEach((e, i) => {
        const p = `biomeRule.rules[${i}]`
        if (!c.obj(p, e)) return
        c.str(`${p}.biome`, e.biome, biomeNames)
        c.num(`${p}.minHeight`, e.minHeight, { optional: true })
        c.num(`${p}.maxHeight`, e.maxHeight, { optional: true })
        c.range(`${p}.moisture`, e.moisture, true)
      })
    }
  }

  const outOps: OpDef[] = []
  if (c.arr('ops', d.ops)) {
    const ids = new Set<string>()
    d.ops.forEach((raw, i) => {
      const p = `ops[${i}]`
      if (!c.obj(p, raw)) return
      if (c.str(`${p}.id`, raw.id)) {
        if (ids.has(raw.id)) c.fail(`${p}.id`, `duplicate id "${raw.id}"`)
        ids.add(raw.id)
      }
      const impl = typeof raw.type === 'string' ? ops.get(raw.type) : undefined
      if (!impl) {
        c.fail(`${p}.type`, typeof raw.type === 'string' ? `unknown op type "${raw.type}" (known: ${ops.types().join(', ')})` : 'is required')
        return
      }
      c.bool(`${p}.enabled`, raw.enabled, true)
      if (raw.blend !== undefined) {
        if (impl.kind !== 'height') c.fail(`${p}.blend`, 'only height ops take a blend')
        else c.str(`${p}.blend`, raw.blend, BLEND_MODES)
      }
      const params = raw.params === undefined ? {} : raw.params
      if (!c.obj(`${p}.params`, params)) return
      if (!checkShape(c, `${p}.shape`, raw.shape, impl.shapes, impl.needY ?? false)) return
      const op: OpDef = {
        id: String(raw.id), type: impl.type, enabled: raw.enabled !== false,
        shape: raw.shape as ShapeDef, params: params as Record<string, unknown>,
      }
      if (raw.blend !== undefined) op.blend = raw.blend as BlendMode
      impl.validate(c, p, op, { biomes: biomeNames, height })
      outOps.push(op)
    })
  }

  const size = Array.isArray(d.size) ? d.size : null
  const layers = size && size.length === 2
    ? checkLayers(c, 'layers', d.layers, { sizeX: Number(size[0]), sizeZ: Number(size[1]), height, biomeCount: biomeNames.length })
    : {}

  if (c.errors.length > 0) return { ok: false, errors: c.errors }
  const doc: TerrainDoc = {
    format: TERRAIN_FORMAT, version: TERRAIN_VERSION,
    size: [...(d.size as [number, number])],
    seaLevel: d.seaLevel as number,
    blocks: { ...DEFAULT_BLOCKS, ...(d.blocks as Partial<BlockNames> | undefined) },
    base: d.base as unknown as TerrainDoc['base'],
    biomes: d.biomes as TerrainDoc['biomes'],
    biomeRule: d.biomeRule as unknown as TerrainDoc['biomeRule'],
    ops: outOps,
    layers,
  }
  return { ok: true, doc }
}

function checkRule(c: Check, p: string, r: unknown): void {
  if (!c.obj(p, r)) return
  const hasBands = c.obj(`${p}.bands`, r.bands, true)
  c.str(`${p}.block`, r.block, undefined, hasBands)
  if (hasBands) {
    const b = r.bands as Record<string, unknown>
    if (c.arr(`${p}.bands.blocks`, b.blocks, 1)) b.blocks.forEach((k, j) => c.str(`${p}.bands.blocks[${j}]`, k))
    c.num(`${p}.bands.thickness`, b.thickness, { int: true, min: 1 })
  }
  if (c.range(`${p}.depth`, r.depth, true) && r.depth[0] < 0) c.fail(`${p}.depth`, 'must be >= 0')
  c.range(`${p}.slope`, r.slope, true)
  c.range(`${p}.y`, r.y, true)
  c.bool(`${p}.underwater`, r.underwater, true)
  c.num(`${p}.nearWater`, r.nearWater, { min: 0, optional: true })
  c.bool(`${p}.ceiling`, r.ceiling, true)
}
