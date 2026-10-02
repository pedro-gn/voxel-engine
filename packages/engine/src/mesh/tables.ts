import type { BlockRegistry } from '../blocks/registry.ts'

/** Plain typed arrays, so they can be posted to mesh workers. */
export interface MeshTables {
  opaque: Uint8Array
  layer: Uint8Array
  liquid: Uint8Array
  faceLayers: Uint16Array
}

export function meshTablesFrom(registry: BlockRegistry, faceLayers: Uint16Array): MeshTables {
  return { opaque: registry.opaque, layer: registry.layer, liquid: registry.liquid, faceLayers }
}
