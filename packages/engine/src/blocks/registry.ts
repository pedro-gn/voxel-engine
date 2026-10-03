import { MAX_BLOCK_ID } from '../world/voxel.ts'

export type RenderLayer = 'opaque' | 'cutout' | 'translucent' | 'liquid'
export const LAYER = { NONE: 0, OPAQUE: 1, CUTOUT: 2, TRANSLUCENT: 3, LIQUID: 4 } as const
export const FACE_COUNT = 6 // +X, -X, +Y, -Y, +Z, -Z

export interface BlockDef {
  name: string
  textures?: string | { top: string; side: string; bottom: string }
  solid?: boolean
  opaque?: boolean
  layer?: RenderLayer
  emits?: number
  liquid?: boolean
  decoration?: string
  /** Falls when the cell below is air or a flowing liquid (sand, gravel). Cannot be combined with `liquid`. */
  falls?: boolean
  /** Makes this liquid block a spring of the named liquid: it counts as full and injects that liquid every fluid step. */
  source?: string
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
  /** 1 for a spring (a liquid with `source`). */
  readonly source: Uint8Array
  /** The base liquid's id for a liquid or a spring; 0 for every other block. */
  readonly liquidGroup: Uint16Array
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
    this.source = new Uint8Array(this.count)
    this.liquidGroup = new Uint16Array(this.count)

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
      this.layer[id] = LAYER_CODE[layer]
      this.opaque[id] = (d.opaque ?? layer === 'opaque') ? 1 : 0
      this.solid[id] = (d.solid ?? !liquid) ? 1 : 0 // liquids default to non-solid
      this.liquid[id] = liquid ? 1 : 0
      this.emits[id] = emits
      const t = d.textures ?? d.name
      const [top, side, bottom] = typeof t === 'string' ? [t, t, t] : [t.top, t.side, t.bottom]
      this.faceTex.push(side, side, top, bottom, side, side)
    })

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
