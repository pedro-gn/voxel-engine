import { OpRegistry, type OpImpl } from './registry.ts'

/** Every built-in op, in a stable order. */
export const BUILTIN_OPS: readonly OpImpl[] = []

export const builtinOps = new OpRegistry(BUILTIN_OPS)
