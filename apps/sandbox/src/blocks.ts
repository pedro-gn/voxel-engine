import { defineBlock } from '@elovox/engine'

export const BLOCKS = [
  defineBlock({ name: 'stone', textures: 'stone' }),
  defineBlock({ name: 'dirt', textures: 'dirt' }),
  defineBlock({ name: 'grass', textures: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' }, decoration: 'grassTuft' }),
  defineBlock({ name: 'sand', textures: 'sand' }),
  defineBlock({ name: 'log', textures: { top: 'log_top', side: 'log_side', bottom: 'log_top' } }),
  defineBlock({ name: 'planks', textures: 'planks' }),
  defineBlock({ name: 'leaves', textures: 'leaves', layer: 'cutout' }),
  defineBlock({ name: 'glass', textures: 'glass', layer: 'translucent' }),
  defineBlock({ name: 'water', textures: 'water', liquid: true, solid: false }),
  defineBlock({ name: 'torch', textures: 'torch', layer: 'cutout', emits: 14, solid: false }),
]
