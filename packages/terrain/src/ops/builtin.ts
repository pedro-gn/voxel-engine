import { biome } from './biome.ts'
import { flatten } from './flatten.ts'
import { hills } from './hills.ts'
import { mountain } from './mountain.ts'
import { plateau } from './plateau.ts'
import { OpRegistry, type OpImpl } from './registry.ts'

/** Every built-in op, in a stable order. */
export const BUILTIN_OPS: readonly OpImpl[] = [hills, mountain, plateau, flatten, biome]

export const builtinOps = new OpRegistry(BUILTIN_OPS)
