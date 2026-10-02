import type { BlockRegistry } from '../blocks/registry.ts'
import { emptyDecorationTables, type DecorationTables } from '../render/decorations/defs.ts'

/** Plain typed arrays, so they can be posted to mesh workers. */
export interface MeshTables {
  opaque: Uint8Array
  layer: Uint8Array
  liquid: Uint8Array
  faceLayers: Uint16Array
  deco: DecorationTables
}

export function meshTablesFrom(registry: BlockRegistry, faceLayers: Uint16Array, deco: DecorationTables = emptyDecorationTables(registry.count)): MeshTables {
  return { opaque: registry.opaque, layer: registry.layer, liquid: registry.liquid, faceLayers, deco }
}
