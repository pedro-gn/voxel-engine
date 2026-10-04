import type { Check } from '../doc/check.ts'
import type { BlendMode, OpDef, ShapeKind } from '../doc/types.ts'
import type { Box, Rect } from '../geom.ts'
import { checkParams, type ParamSchema } from './schema.ts'

/** The 2D state of one column while height ops run. */
export interface Cell {
  /** Ground height: voxels with y < round(h) are solid (before volume ops). */
  h: number
  /** Water level from rivers and lakes (non-solid voxels below it become water); -1 = none. */
  water: number
  /** Water reference for `nearWater` surface rules (banks and shores); -Infinity = none. */
  wet: number
  /** Biome index set by a biome op; -1 = none. */
  biome: number
}

export interface ValidateContext {
  /** Biome names declared by the document, in order. */
  readonly biomes: readonly string[]
  /** World height (y size). */
  readonly height: number
}

export interface CompileContext {
  readonly seed: number
  readonly height: number
  readonly seaLevel: number
  biomeIndex(name: string): number
}

export interface HeightOp {
  readonly id: string
  /** Columns outside these bounds are never touched by `apply`. */
  readonly bounds: Rect
  apply(x: number, z: number, cell: Cell): void
  /** A spring this op places: in the lowest water cell of column (x, z), with this flow index (0–15). */
  readonly spring?: { readonly x: number; readonly z: number; readonly flow: number }
}

export interface VolumeOp {
  readonly id: string
  /** Where `density` can be positive (for 'add') or where it carves (for 'carve'). */
  readonly bounds: Box
  /** add: solid = max(solid, density); carve: solid = min(solid, -density). */
  readonly mode: 'add' | 'carve'
  /** Signed distance-like field in blocks: > 0 inside the op's volume. */
  density(x: number, y: number, z: number): number
}

interface OpImplBase {
  readonly type: string
  /** Shape kinds this op accepts. */
  readonly shapes: readonly ShapeKind[]
  /** Requires y on every path point (volume ops along paths). */
  readonly needY?: boolean
  /** The op's params. Validation, defaults (paramsOf) and the editor's inspector all read it. */
  readonly params: ParamSchema
  /** True if the op reads `shape.falloff`; a falloff > 0 on any other op is an error. */
  readonly falloff: boolean
  /** Validates the falloff and `def.params` (shape and common fields are already valid). Built by defineTerrainOp. */
  validate(c: Check, path: string, def: OpDef, ctx: ValidateContext): void
}
export interface HeightOpImpl extends OpImplBase {
  readonly kind: 'height'
  readonly defaultBlend: BlendMode
  compile(def: OpDef, ctx: CompileContext): HeightOp
}
export interface VolumeOpImpl extends OpImplBase {
  readonly kind: 'volume'
  compile(def: OpDef, ctx: CompileContext): VolumeOp
}
export type OpImpl = HeightOpImpl | VolumeOpImpl

type Spec<T extends OpImpl> = Omit<T, 'validate'> & {
  /** Rules the schema cannot express (an arch takes exactly 2 points). Runs before the params are checked. */
  check?(c: Check, path: string, def: OpDef, ctx: ValidateContext): void
}
export type HeightOpSpec = Spec<HeightOpImpl>
export type VolumeOpSpec = Spec<VolumeOpImpl>

/** Builds an op from its spec; `validate` comes from `falloff`, `check` and `params`. Register it with `builtinOps.with(myOp)`. */
export function defineTerrainOp(spec: HeightOpSpec): HeightOpImpl
export function defineTerrainOp(spec: VolumeOpSpec): VolumeOpImpl
export function defineTerrainOp(spec: HeightOpSpec | VolumeOpSpec): OpImpl {
  const { check, ...impl } = spec
  return {
    ...impl,
    validate(c, path, def, ctx) {
      const f = def.shape.falloff
      if (!impl.falloff && f !== undefined && f > 0) c.fail(`${path}.shape.falloff`, `${impl.type} does not use a falloff`)
      check?.(c, path, def, ctx)
      checkParams(c, path, def, impl.params, ctx)
    },
  } as OpImpl
}

export class OpRegistry {
  private readonly byType = new Map<string, OpImpl>()

  constructor(impls: readonly OpImpl[]) {
    for (const impl of impls) {
      if (this.byType.has(impl.type)) throw new Error(`duplicate terrain op type "${impl.type}"`)
      this.byType.set(impl.type, impl)
    }
  }

  get(type: string): OpImpl | undefined { return this.byType.get(type) }

  types(): string[] { return [...this.byType.keys()] }

  /** A new registry with extra (custom) ops. */
  with(...impls: OpImpl[]): OpRegistry { return new OpRegistry([...this.byType.values(), ...impls]) }
}
