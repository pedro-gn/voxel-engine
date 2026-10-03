import type { Check } from '../doc/check.ts'
import type { BlendMode, OpDef, ShapeKind } from '../doc/types.ts'
import type { Box, Rect } from '../geom.ts'

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
  /** Validates `def.params` (shape and common fields are already valid). */
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

/** Identity helper that types a custom op. Register it with `builtinOps.with(myOp)`. */
export function defineTerrainOp(impl: HeightOpImpl): HeightOpImpl
export function defineTerrainOp(impl: VolumeOpImpl): VolumeOpImpl
export function defineTerrainOp(impl: OpImpl): OpImpl { return impl }

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
