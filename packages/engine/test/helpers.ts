import { BlockRegistry, defineBlock, type BlockDef } from '../src/blocks/registry.ts'

export const TEST_BLOCKS: BlockDef[] = [
  defineBlock({ name: 'stone', textures: 'stone' }),
  defineBlock({ name: 'dirt', textures: 'dirt' }),
  defineBlock({ name: 'grass', textures: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' } }),
  defineBlock({ name: 'glass', textures: 'glass', layer: 'translucent' }),
  defineBlock({ name: 'water', textures: 'water', liquid: true, solid: false }),
  defineBlock({ name: 'torch', textures: 'torch', layer: 'cutout', emits: 14, solid: false }),
  defineBlock({ name: 'leaves', textures: 'leaves', layer: 'cutout' }),
]

export function testRegistry(): BlockRegistry {
  return new BlockRegistry(TEST_BLOCKS)
}

export const ID = { air: 0, stone: 1, dirt: 2, grass: 3, glass: 4, water: 5, torch: 6, leaves: 7 } as const
