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

/** Shaped stone, appended after `TEST_BLOCKS` by `testRegistry()` (ids 8–10), so tests that append their own blocks to `TEST_BLOCKS` keep their ids. */
export const SHAPED_TEST_BLOCKS: BlockDef[] = [
  defineBlock({ name: 'stone_slab', textures: 'stone', shape: 'slab' }),
  defineBlock({ name: 'stone_stair', textures: 'stone', shape: 'stair' }),
  defineBlock({ name: 'stone_post', textures: 'stone', shape: 'post' }),
]

export function testRegistry(): BlockRegistry {
  return new BlockRegistry([...TEST_BLOCKS, ...SHAPED_TEST_BLOCKS])
}

export const ID = { air: 0, stone: 1, dirt: 2, grass: 3, glass: 4, water: 5, torch: 6, leaves: 7, stone_slab: 8, stone_stair: 9, stone_post: 10 } as const

/** A ladder and a torch on a post, appended after the shaped blocks by `ladderRegistry()` (ids 11–12); `testRegistry()` keeps none, so its worlds stay ladder-free. */
export const LADDER_TEST_BLOCKS: BlockDef[] = [
  defineBlock({ name: 'ladder', textures: 'ladder', shape: 'ladder', solid: false, climbable: true }),
  defineBlock({ name: 'torch_post', textures: 'torch_post', shape: 'post', solid: false, emits: 14 }),
]

export function ladderRegistry(): BlockRegistry {
  return new BlockRegistry([...TEST_BLOCKS, ...SHAPED_TEST_BLOCKS, ...LADDER_TEST_BLOCKS])
}

export const LADDER_ID = { ladder: 11, torch_post: 12 } as const
