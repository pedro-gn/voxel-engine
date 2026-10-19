import { MAX_BLOCK_ID } from '../world/voxel.ts'
import { SHAPE, SHAPE_CODE, type BlockShape } from './shapes.ts'

export type RenderLayer = 'opaque' | 'cutout' | 'translucent' | 'liquid'
export const LAYER = { NONE: 0, OPAQUE: 1, CUTOUT: 2, TRANSLUCENT: 3, LIQUID: 4, SHAPE: 5 } as const
export const FACE_COUNT = 6 // +X, -X, +Y, -Y, +Z, -Z

export interface BlockDef {
  name: string
  textures?: string | { top: string; side: string; bottom: string }
  solid?: boolean
  opaque?: boolean
  layer?: RenderLayer
  /** False when a client-owned model draws the block: keep its voxel semantics, but emit no chunk faces. */
  render?: boolean
  emits?: number
  liquid?: boolean
  decoration?: string
  /** Falls when the cell below is air or a flowing liquid (sand, gravel). Cannot be combined with `liquid`. */
  falls?: boolean
  /** Joins face-connected structural fragments. Normal blocks keep their existing behavior. */
  collapses?: boolean
  /** Makes this liquid block a spring of the named liquid: it counts as full and injects that liquid every fluid step. */
  source?: string
  /** Draws the block as a slab, stair or post oriented by its voxel state; every system but drawing and light treats it as a full cell. */
  shape?: BlockShape
}

export function defineBlock(def: BlockDef): BlockDef {
  return def
}

const LAYER_CODE: Record<RenderLayer, number> = { opaque: LAYER.OPAQUE, cutout: LAYER.CUTOUT, translucent: LAYER.TRANSLUCENT, liquid: LAYER.LIQUID }

export class BlockRegistry {
  readonly count: number
  readonly defs: readonly BlockDef[]
  readonly opaque: Uint8Array
  readonly solid: Uint8Array
  readonly layer: Uint8Array
  readonly liquid: Uint8Array
  readonly emits: Uint8Array
  readonly falls: Uint8Array
  readonly collapses: Uint8Array
  /** 0 = no support, 1 = structural member, 2 = fixed normal solid. */
  readonly structural: Uint8Array
  readonly hasCollapse: boolean
  /** 1 for a spring (a liquid with `source`). */
  readonly source: Uint8Array
  /** The base liquid's id for a liquid or a spring; 0 for every other block. */
  readonly liquidGroup: Uint16Array
  /** `SHAPE` code per id; 0 for whole cubes. */
  readonly shape: Uint8Array
  /** 1 when the block stops sky and block light: opaque cubes, slabs and stairs. */
  readonly blocksLight: Uint8Array
  private readonly ids = new Map<string, number>()
  private readonly faceTex: (string | null)[] = []

  constructor(defs: readonly BlockDef[]) {
    if (defs.length + 1 > MAX_BLOCK_ID + 1) throw new RangeError(`too many blocks: ${defs.length + 1} > 4096`)
    const all: BlockDef[] = [{ name: 'air', solid: false, opaque: false }, ...defs]
    this.count = all.length
    this.defs = all
    this.opaque = new Uint8Array(this.count)
    this.solid = new Uint8Array(this.count)
    this.layer = new Uint8Array(this.count)
    this.liquid = new Uint8Array(this.count)
    this.emits = new Uint8Array(this.count)
    this.falls = new Uint8Array(this.count)
    this.collapses = new Uint8Array(this.count)
    this.structural = new Uint8Array(this.count)
    this.source = new Uint8Array(this.count)
    this.liquidGroup = new Uint16Array(this.count)
    this.shape = new Uint8Array(this.count)
    this.blocksLight = new Uint8Array(this.count)

    all.forEach((d, id) => {
      if (id > 0 && d.name === 'air') throw new Error(`block name "air" is reserved`)
      if (this.ids.has(d.name)) throw new Error(`duplicate block name "${d.name}"`)
      const emits = d.emits ?? 0
      if (!Number.isInteger(emits) || emits < 0 || emits > 15) throw new RangeError(`block "${d.name}": emits must be 0–15`)
      this.ids.set(d.name, id)
      if (id === 0) {
        for (let f = 0; f < 6; f++) this.faceTex.push(null)
        return
      }
      const liquid = d.liquid ?? false
      const falls = d.falls ?? false
      if (falls && liquid) throw new Error(`block "${d.name}": falls cannot be combined with liquid`)
      if (d.source !== undefined && !liquid) throw new Error(`block "${d.name}": source needs liquid: true`)
      this.falls[id] = falls ? 1 : 0
      const layer: RenderLayer = d.layer ?? (liquid ? 'liquid' : 'opaque')
      if (layer === 'liquid' && !liquid) throw new Error(`block "${d.name}": layer "liquid" needs liquid: true`)
      if (d.shape !== undefined) {
        const word = liquid ? 'liquid' : d.decoration !== undefined ? 'decoration' : d.render === false ? 'render: false'
          : falls ? 'falls' : layer !== 'opaque' ? `layer "${layer}"` : null
        if (word !== null) throw new Error(`block "${d.name}": shape "${d.shape}" cannot be combined with ${word}`)
        this.shape[id] = SHAPE_CODE[d.shape]
      }
      this.layer[id] = d.render === false ? LAYER.NONE : d.shape !== undefined ? LAYER.SHAPE : LAYER_CODE[layer]
      this.opaque[id] = d.shape === undefined && (d.opaque ?? layer === 'opaque') ? 1 : 0
      this.blocksLight[id] = this.opaque[id] || this.shape[id] === SHAPE.SLAB || this.shape[id] === SHAPE.STAIR ? 1 : 0
      this.solid[id] = (d.solid ?? !liquid) ? 1 : 0 // liquids default to non-solid
      if (d.collapses && (falls || liquid || d.source !== undefined || this.solid[id] !== 1)) {
        throw new Error(`block "${d.name}": collapses requires a solid, non-liquid block without falls or source`)
      }
      this.collapses[id] = d.collapses ? 1 : 0
      this.structural[id] = d.collapses ? 1 : this.solid[id] && !falls && !liquid ? 2 : 0
      this.liquid[id] = liquid ? 1 : 0
      this.emits[id] = emits
      const t = d.textures ?? d.name
      const [top, side, bottom] = typeof t === 'string' ? [t, t, t] : [t.top, t.side, t.bottom]
      this.faceTex.push(side, side, top, bottom, side, side)
    })

    this.hasCollapse = this.collapses.includes(1)
    all.forEach((d, id) => {
      if (!this.liquid[id]) return
      if (d.source === undefined) { this.liquidGroup[id] = id; return }
      const target = this.ids.get(d.source)
      if (target === undefined) throw new Error(`block "${d.name}": source names "${d.source}", which is not a block`)
      if (!this.liquid[target] || all[target]!.source !== undefined) {
        throw new Error(`block "${d.name}": source "${d.source}" must be a liquid that is not itself a source`)
      }
      this.source[id] = 1
      this.liquidGroup[id] = target
    })
  }

  id(name: string): number {
    const id = this.ids.get(name)
    if (id === undefined) throw new Error(`unknown block "${name}"`)
    return id
  }

  name(id: number): string {
    const d = this.defs[id]
    if (!d) throw new Error(`unknown block id ${id}`)
    return d.name
  }

  textureNames(): string[] {
    const seen = new Set<string>()
    for (const t of this.faceTex) if (t !== null) seen.add(t)
    return [...seen]
  }

  faceLayers(layerOf: ReadonlyMap<string, number>): Uint16Array {
    const out = new Uint16Array(this.count * 6)
    this.faceTex.forEach((t, i) => { out[i] = t === null ? 0 : (layerOf.get(t) ?? 0) })
    return out
  }
}

/** The liquid the water simulation moves: the first liquid block that is not a spring; 0 when the registry has none. */
export function waterGroupOf(reg: BlockRegistry): number {
  for (let id = 1; id < reg.count; id++) if (reg.liquid[id] === 1 && reg.source[id] === 0) return id
  return 0
}
