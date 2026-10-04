import type { BlockRegistry } from '../blocks/registry.ts'
import { emptyDecorationTables, type DecorationTables } from '../render/decorations/defs.ts'

/** Plain typed arrays, so they can be posted to mesh workers. */
export interface MeshTables {
  opaque: Uint8Array
  layer: Uint8Array
  liquid: Uint8Array
  /** Base liquid id of a liquid or spring; 0 otherwise. Liquids of one group share corners and hide faces between them. */
  liquidGroup: Uint16Array
  /** 1 for a spring: drawn at full level whatever its state. */
  source: Uint8Array
  faceLayers: Uint16Array
  deco: DecorationTables
}

/** Liquid faces carry flow bits in word B bits 9-11, so their texture layer must fit in 9 bits. */
export const MAX_LIQUID_LAYER = 511

export function meshTablesFrom(registry: BlockRegistry, faceLayers: Uint16Array, deco: DecorationTables = emptyDecorationTables(registry.count)): MeshTables {
  for (let id = 0; id < registry.count; id++) {
    if (registry.liquid[id] !== 1) continue
    for (let f = 0; f < 6; f++) {
      const layer = faceLayers[id * 6 + f]!
      if (layer > MAX_LIQUID_LAYER) throw new RangeError(`liquid block "${registry.name(id)}" uses texture layer ${layer}; liquid textures must sit below layer 512`)
    }
  }
  return {
    opaque: registry.opaque, layer: registry.layer, liquid: registry.liquid,
    liquidGroup: registry.liquidGroup, source: registry.source, faceLayers, deco,
  }
}
