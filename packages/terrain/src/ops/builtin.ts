import { biome } from './biome.ts'
import { flatten } from './flatten.ts'
import { hills } from './hills.ts'
import { lake } from './lake.ts'
import { mountain } from './mountain.ts'
import { plateau } from './plateau.ts'
import { river } from './river.ts'
import { OpRegistry, type OpImpl } from './registry.ts'
import { valley } from './valley.ts'

/** Every built-in op, in a stable order. */
export const BUILTIN_OPS: readonly OpImpl[] = [hills, mountain, plateau, flatten, biome, valley, river, lake]

export const builtinOps = new OpRegistry(BUILTIN_OPS)
