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
  /** Draws the block as a slab, stair, post or ladder oriented by its voxel state; every system but drawing and light treats it as `solid` says (a full cell by default). */
  shape?: BlockShape
  /** Units climb it: a cell holding it is a pose without a floor, joined to the climbable cells above and below. Needs `solid: false` and no `liquid`. */
  climbable?: boolean
  /** Water flows through the cell as if it were air, and the water mirror never writes it (an open gate). Units still see the block as `solid` says. Cannot be combined with `liquid`. */
  passesWater?: boolean
  /**
   * Leaf tone (off by default): the cutout material multiplies the block's albedo by a tint between `dark` and `light`
   * (linear-RGB multipliers) picked by the voxel state's bits 0–1 (0 = dark … 3 = light), times a ±`jitter` hash of the
   * cell (default 0.035). Needs `layer: 'cutout'`, a whole cube (no `shape`), no `liquid` and `render !== false`. Blocks
   * sharing a face texture must declare the same tone; a world with any tone block holds at most 256 texture layers.
   */
  tone?: BlockTone
  /**
   * Leafy fringe (off by default): the mesher adds thin alpha-cut strips on the block's convex silhouette edges — an
   * edge of an exposed face where the cell beyond the edge and the cell diagonal to it are both neither opaque nor the
   * same block. A strip lies in its face's plane and reaches `width` blocks out (`hang` when it points down), quantised
   * to sixteenths (1/16–1; defaults 5/16 and 7/16; `width` ≤ 1/2 and `width + hang` ≤ 1, so the strips of two blocks one
 * free cell apart never overlap). `texture` is a mask drawn across the strip: u along the edge, v from
   * the block edge (v = 0, the image's bottom row) to the strip's outer edge (v = 1, its top row). Strips are lit like
   * their face, take the block's tone, cast no shadow and are neither picked nor collided. Same validity as `tone`.
   */
  fringe?: BlockFringe
}

export interface BlockFringe {
  texture: string
  width?: number
  hang?: number
  /** Strips on a side face's vertical edges, reaching sideways (default true); false keeps only up, down and top/bottom-face strips. */
  sides?: boolean
}

/** Fringe reach defaults, in sixteenths of a block. */
export const DEFAULT_FRINGE_WIDTH = 5
export const DEFAULT_FRINGE_HANG = 7

export interface BlockTone {
  dark: readonly [number, number, number]
  light: readonly [number, number, number]
  jitter?: number
}

/** The jitter a tone gets when it does not say. */
export const DEFAULT_TONE_JITTER = 0.035
/** Texture-array layers a world with tone blocks may hold: the cutout stream keeps 8 bits of word B's layer field for the layer. */
export const TONE_MAX_LAYERS = 256

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
  /** 1 for a climbable block (a ladder). */
  readonly climbable: Uint8Array
  /** True when any block is climbable: navigation then adds its up and down moves. */
  readonly hasClimbable: boolean
  /** 1 for a block water flows through (`passesWater`). */
  readonly passesWater: Uint8Array
  /** 1 for a block with `tone`. */
  readonly tone: Uint8Array
  /** True when any block has `tone`: the mesher then writes tone bits in the cutout stream and the cutout material decodes them. */
  readonly hasTone: boolean
  /** True when any block has `fringe`: the mesher runs its fringe pass and the cutout material decodes strips. */
  readonly hasFringe: boolean
  /** A fringe block's strip reach, in sixteenths (0 for a block without fringe). */
  readonly fringeWidth: Uint8Array
  /** A fringe block's down-pointing strip reach, in sixteenths. */
  readonly fringeHang: Uint8Array
  /** Per id: 1 when its side faces grow sideways strips on their vertical edges (BlockFringe.sides, default on). */
  readonly fringeSides: Uint8Array
  /** The largest strip reach of any fringe block, in blocks (0 without fringe): how far strips poke out of their chunk. */
  readonly fringeReach: number
  private readonly ids = new Map<string, number>()
  private readonly faceTex: (string | null)[] = []
  /** Per id: its fringe texture, or null. */
  private readonly fringeTex: (string | null)[] = []

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
    this.climbable = new Uint8Array(this.count)
    this.passesWater = new Uint8Array(this.count)
    this.tone = new Uint8Array(this.count)
    this.fringeWidth = new Uint8Array(this.count)
    this.fringeHang = new Uint8Array(this.count)
    this.fringeSides = new Uint8Array(this.count)

    all.forEach((d, id) => {
      if (id > 0 && d.name === 'air') throw new Error(`block name "air" is reserved`)
      if (this.ids.has(d.name)) throw new Error(`duplicate block name "${d.name}"`)
      const emits = d.emits ?? 0
      if (!Number.isInteger(emits) || emits < 0 || emits > 15) throw new RangeError(`block "${d.name}": emits must be 0–15`)
      this.ids.set(d.name, id)
      if (id === 0) {
        for (let f = 0; f < 6; f++) this.faceTex.push(null)
        this.fringeTex.push(null)
        return
      }
      const liquid = d.liquid ?? false
      const falls = d.falls ?? false
      if (falls && liquid) throw new Error(`block "${d.name}": falls cannot be combined with liquid`)
      if (d.source !== undefined && !liquid) throw new Error(`block "${d.name}": source needs liquid: true`)
      this.falls[id] = falls ? 1 : 0
      const layer: RenderLayer = d.layer ?? (liquid ? 'liquid' : 'opaque')
      if (layer === 'liquid' && !liquid) throw new Error(`block "${d.name}": layer "liquid" needs liquid: true`)
      if (d.tone !== undefined) {
        if (layer !== 'cutout' || d.shape !== undefined || liquid || d.render === false) {
          throw new Error(`block "${d.name}": tone needs layer "cutout", a whole cube (no shape), no liquid and render !== false`)
        }
        checkTone(d.name, d.tone)
        this.tone[id] = 1
      }
      if (d.fringe !== undefined) {
        if (layer !== 'cutout' || d.shape !== undefined || liquid || d.render === false) {
          throw new Error(`block "${d.name}": fringe needs layer "cutout", a whole cube (no shape), no liquid and render !== false`)
        }
        if (typeof d.fringe.texture !== 'string' || d.fringe.texture === '') throw new Error(`block "${d.name}": fringe needs a texture`)
        this.fringeWidth[id] = sixteenths(d.name, 'width', d.fringe.width, DEFAULT_FRINGE_WIDTH)
        this.fringeHang[id] = sixteenths(d.name, 'hang', d.fringe.hang, DEFAULT_FRINGE_HANG)
        this.fringeSides[id] = d.fringe.sides === false ? 0 : 1
        // Two blocks one free cell apart: their facing strips meet in that cell's plane and must not overlap (z-fight).
        if (2 * this.fringeWidth[id]! > 16) throw new RangeError(`block "${d.name}": fringe width must be at most 1/2 block`)
        if (this.fringeWidth[id]! + this.fringeHang[id]! > 16) throw new RangeError(`block "${d.name}": fringe width + hang must be at most 1 block`)
      }
      this.fringeTex.push(d.fringe?.texture ?? null)
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
      if (d.climbable) {
        if (liquid || this.solid[id] === 1) throw new RangeError(`block "${d.name}": climbable needs solid: false and no liquid`)
        this.climbable[id] = 1
      }
      if (d.passesWater) {
        if (liquid) throw new Error(`block "${d.name}": passesWater cannot be combined with liquid`)
        this.passesWater[id] = 1
      }
      this.emits[id] = emits
      const t = d.textures ?? d.name
      const [top, side, bottom] = typeof t === 'string' ? [t, t, t] : [t.top, t.side, t.bottom]
      this.faceTex.push(side, side, top, bottom, side, side)
    })

    this.hasCollapse = this.collapses.includes(1)
    this.hasClimbable = this.climbable.includes(1)
    this.hasTone = this.tone.includes(1)
    this.hasFringe = this.fringeWidth.some((w) => w !== 0)
    let reach = 0
    for (let id = 0; id < this.count; id++) reach = Math.max(reach, this.fringeWidth[id]!, this.fringeHang[id]!)
    this.fringeReach = reach / 16
    if (this.hasTone) this.checkToneTextures()
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

  /** Every texture the blocks draw: face textures in first-appearance order, then fringe textures. */
  textureNames(): string[] {
    const seen = new Set<string>()
    for (const t of this.faceTex) if (t !== null) seen.add(t)
    for (const t of this.fringeTex) if (t !== null) seen.add(t)
    return [...seen]
  }

  /** Per id: the texture-array layer of its fringe texture; 0 for a block without fringe. */
  fringeLayers(layerOf: ReadonlyMap<string, number>): Uint16Array {
    const out = new Uint16Array(this.count)
    this.fringeTex.forEach((t, id) => { out[id] = t === null ? 0 : (layerOf.get(t) ?? 0) })
    return out
  }

  /** Every texture a block draws: its six faces and its fringe. */
  private texturesOf(id: number): string[] {
    const out: string[] = []
    for (let f = 0; f < 6; f++) out.push(this.faceTex[id * 6 + f]!)
    const fr = this.fringeTex[id]
    if (fr !== null && fr !== undefined) out.push(fr)
    return out
  }

  /**
   * Per texture-array layer (sized to the largest layer in `layerOf` + 1): 3 floats each of the dark and light tints and
   * 1 of jitter. A layer drawn by a tone block holds its tone; every other layer dark = light = 1, jitter 0.
   */
  toneLayers(layerOf: ReadonlyMap<string, number>): { dark: Float32Array; light: Float32Array; jitter: Float32Array } {
    let n = 1
    for (const l of layerOf.values()) n = Math.max(n, l + 1)
    const dark = new Float32Array(n * 3).fill(1), light = new Float32Array(n * 3).fill(1), jitter = new Float32Array(n)
    for (const [name, tone] of this.toneByTexture()) {
      const l = layerOf.get(name)
      if (l === undefined) continue
      dark.set(tone.dark, l * 3)
      light.set(tone.light, l * 3)
      jitter[l] = tone.jitter ?? DEFAULT_TONE_JITTER
    }
    return { dark, light, jitter }
  }

  /** Texture name → the tone of the tone blocks drawing it. */
  private toneByTexture(): Map<string, BlockTone> {
    const out = new Map<string, BlockTone>()
    for (let id = 1; id < this.count; id++) {
      if (!this.tone[id]) continue
      const tone = this.defs[id]!.tone!
      for (const tex of this.texturesOf(id)) out.set(tex, tone)
    }
    return out
  }

  /**
   * The tint is looked up per texture layer, so a layer must mean one tone: tone blocks sharing a texture agree, and no
   * other cutout block draws a tone texture (its faces would take the dark tint). The cutout stream keeps 8 bits for
   * the layer.
   */
  private checkToneTextures(): void {
    const owner = new Map<string, number>()
    for (let id = 1; id < this.count; id++) {
      if (!this.tone[id]) continue
      for (const tex of this.texturesOf(id)) {
        const other = owner.get(tex)
        if (other === undefined) { owner.set(tex, id); continue }
        if (!sameTone(this.defs[other]!.tone!, this.defs[id]!.tone!)) {
          throw new Error(`blocks "${this.defs[other]!.name}" and "${this.defs[id]!.name}" share texture "${tex}" with different tones`)
        }
      }
    }
    for (let id = 1; id < this.count; id++) {
      if (this.tone[id] || this.layer[id] !== LAYER.CUTOUT) continue
      for (const tex of this.texturesOf(id)) {
        const other = owner.get(tex)
        if (other !== undefined) {
          throw new Error(`block "${this.defs[id]!.name}" draws texture "${tex}" of tone block "${this.defs[other]!.name}" without its tone`)
        }
      }
    }
    const layers = this.textureNames().length + 1 // layer 0 is the missing-texture checker
    if (layers > TONE_MAX_LAYERS) throw new RangeError(`tone blocks allow at most ${TONE_MAX_LAYERS} texture layers, the blocks use ${layers}`)
  }

  faceLayers(layerOf: ReadonlyMap<string, number>): Uint16Array {
    const out = new Uint16Array(this.count * 6)
    this.faceTex.forEach((t, i) => { out[i] = t === null ? 0 : (layerOf.get(t) ?? 0) })
    return out
  }
}

function checkTone(name: string, t: BlockTone): void {
  const rgb = (v: readonly number[]) => v.length === 3 && v.every((c) => typeof c === 'number' && Number.isFinite(c) && c >= 0)
  if (!rgb(t.dark) || !rgb(t.light)) throw new RangeError(`block "${name}": tone dark and light must be three finite numbers ≥ 0`)
  const j = t.jitter ?? DEFAULT_TONE_JITTER
  if (!Number.isFinite(j) || j < 0 || j > 1) throw new RangeError(`block "${name}": tone jitter must be in [0, 1]`)
}

/** A fringe reach in blocks -> sixteenths in 1..16. */
function sixteenths(name: string, key: string, v: number | undefined, fallback: number): number {
  if (v === undefined) return fallback
  const q = Math.round(v * 16)
  if (!Number.isFinite(v) || q < 1 || q > 16) throw new RangeError(`block "${name}": fringe ${key} must be in [1/16, 1] blocks`)
  return q
}

function sameTone(a: BlockTone, b: BlockTone): boolean {
  return a.dark.every((v, i) => v === b.dark[i]) && a.light.every((v, i) => v === b.light[i])
    && (a.jitter ?? DEFAULT_TONE_JITTER) === (b.jitter ?? DEFAULT_TONE_JITTER)
}

/** The liquid the water simulation moves: the first liquid block that is not a spring; 0 when the registry has none. */
export function waterGroupOf(reg: BlockRegistry): number {
  for (let id = 1; id < reg.count; id++) if (reg.liquid[id] === 1 && reg.source[id] === 0) return id
  return 0
}
