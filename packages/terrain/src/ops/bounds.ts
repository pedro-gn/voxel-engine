import type { OpDef, TerrainDoc } from '../doc/types.ts'
import type { Rect } from '../geom.ts'
import { builtinOps } from './builtin.ts'
import type { CompileContext, OpRegistry } from './registry.ts'

/**
 * The closed xz rectangle an op can change, in blocks. It comes from compiling the op, the same step
 * that generates, so it cannot drift from what the op does. A volume op's box loses its y.
 */
export function opBounds(def: OpDef, doc: TerrainDoc, o: { ops?: OpRegistry; height?: number } = {}): Rect {
  const impl = (o.ops ?? builtinOps).get(def.type)
  if (!impl) throw new Error(`unknown op type "${def.type}"`)
  const names = doc.biomes.map((b) => b.name)
  const ctx: CompileContext = {
    seed: 0, height: o.height ?? 128, seaLevel: doc.seaLevel,
    biomeIndex: (name) => Math.max(0, names.indexOf(name)),
  }
  const b = impl.compile(def, ctx).bounds
  return { x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1 }
}
