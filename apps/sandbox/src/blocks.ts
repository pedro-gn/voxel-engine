import { defineBlock, defineDecoration } from '@elovox/engine'

export const BLOCKS = [
  defineBlock({ name: 'stone', textures: 'stone' }),
  defineBlock({ name: 'dirt', textures: 'dirt' }),
  defineBlock({ name: 'grass', textures: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' }, decoration: 'meadow' }),
  defineBlock({ name: 'sand', textures: 'sand' }),
  defineBlock({ name: 'log', textures: { top: 'log_top', side: 'log_side', bottom: 'log_top' } }),
  defineBlock({ name: 'planks', textures: 'planks' }),
  defineBlock({ name: 'leaves', textures: 'leaves', layer: 'cutout' }),
  defineBlock({ name: 'glass', textures: 'glass', layer: 'translucent' }),
  defineBlock({ name: 'water', textures: 'water', liquid: true, solid: false }),
  defineBlock({ name: 'torch', textures: 'torch', layer: 'cutout', emits: 14, solid: false }),
  defineBlock({ name: 'rock', textures: 'rock' }),
  // terrain toolkit (sub-project 2b)
  defineBlock({ name: 'snow', textures: 'snow' }),
  defineBlock({ name: 'gravel', textures: 'gravel' }),
  defineBlock({ name: 'sandstone', textures: 'sandstone' }),
  defineBlock({ name: 'sandstone_red', textures: 'sandstone_red' }),
  defineBlock({ name: 'pine_leaves', textures: 'pine_leaves', layer: 'cutout' }),
]

export const DECORATIONS = [
  defineDecoration({
    name: 'meadow',
    grass: { blades: 20, height: [0.25, 0.55], base: '#4f8a2e', tip: '#a9d65a', overhang: 0.32 },
    flowers: { chance: 0.06, patchScale: 12, colors: ['#e94b4b', '#f5d142', '#ffffff', '#f08ac0', '#6f8cf0'] },
  }),
]
