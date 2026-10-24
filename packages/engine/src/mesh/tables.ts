import { waterGroupOf, type BlockRegistry } from '../blocks/registry.ts'
import { emptyDecorationTables, type DecorationTables } from '../render/decorations/defs.ts'

/** Plain typed arrays, so they can be posted to mesh workers. */
export interface MeshTables {
  /** The simulated water's block id (waterGroupOf): its voxels at or above a column's floor are drawn by the heightfield. 0: none. */
  waterGroup: number
  opaque: Uint8Array
  layer: Uint8Array
  liquid: Uint8Array
  /** Base liquid id of a liquid or spring; 0 otherwise. Liquids of one group share corners and hide faces between them. */
  liquidGroup: Uint16Array
  /** 1 for a spring: drawn at full level whatever its state. */
  source: Uint8Array
  faceLayers: Uint16Array
  /** `SHAPE` code per id (blocks/shapes.ts); 0 for whole cubes. */
  shape: Uint8Array
  /** 1 when a block stops light: opaque cubes, slabs and stairs. Their own cells hold no light. */
  blocksLight: Uint8Array
  /** False when no block has a shape: the shaped-cell pass is skipped. */
  hasShapes: boolean
  /** 1 for a block with a leaf tone (BlockDef.tone): its cutout vertices carry tone bits (vertexFormat.ts toneLayer). */
  tone?: Uint8Array
  /** True when any block has a tone; false or absent skips every tone branch. */
  hasTone?: boolean
  /** True when any block has a fringe (BlockDef.fringe); false or absent skips the fringe pass. */
  hasFringe?: boolean
  /** Per id: the texture layer of its fringe strips; 0 without fringe. */
  fringeLayers?: Uint16Array
  /** Per id: strip reach in sixteenths (0 without fringe), and the reach of strips that point down. */
  fringeWidth?: Uint8Array
  fringeHang?: Uint8Array
  /** Per id: 1 when side faces grow sideways strips on their vertical edges. */
  fringeSides?: Uint8Array
  deco: DecorationTables
}

/** `fringeLayers`: BlockRegistry.fringeLayers of the same texture array as `faceLayers` (strips draw the checker without it). */
export function meshTablesFrom(
  registry: BlockRegistry, faceLayers: Uint16Array, deco: DecorationTables = emptyDecorationTables(registry.count), fringeLayers?: Uint16Array,
): MeshTables {
  return {
    opaque: registry.opaque, layer: registry.layer, liquid: registry.liquid,
    liquidGroup: registry.liquidGroup, source: registry.source, faceLayers, deco,
    shape: registry.shape, blocksLight: registry.blocksLight, hasShapes: registry.shape.some((c) => c !== 0),
    waterGroup: waterGroupOf(registry),
    tone: registry.tone, hasTone: registry.hasTone,
    hasFringe: registry.hasFringe, fringeLayers: fringeLayers ?? new Uint16Array(registry.count),
    fringeWidth: registry.fringeWidth, fringeHang: registry.fringeHang, fringeSides: registry.fringeSides,
  }
}
