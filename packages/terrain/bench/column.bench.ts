import { bench, describe } from 'vitest'
import { validateTerrainDoc } from '../src/doc/validate.ts'
import { compileTerrain, type CompiledTerrain } from '../src/pipeline/compile.ts'
import { generateRegion } from '../src/pipeline/region.ts'
import { idOf, minimalDoc } from '../test/fixtures.ts'

const H = 128
function compile(extra: Record<string, unknown>): CompiledTerrain {
  const r = validateTerrainDoc({ ...minimalDoc(), size: [512, 512], ...extra }, { worldHeight: H })
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return compileTerrain(r.doc, { seed: 1, height: H, id: idOf })
}

const rolling = {
  base: { height: 40, amplitude: 24, noise: { scale: 120, octaves: 5, warp: { scale: 200, amount: 30 } } },
  biomes: [{ name: 'plain', surface: [{ block: 'stone', slope: [1.5, 99] }, { block: 'grass' }, { block: 'dirt', depth: [1, 3] }], trees: { density: 0.15, kinds: ['broadleaf', 'pine'] }, rocks: { density: 0.03, size: [1, 3] } }],
}
const twoD = compile({
  ...rolling,
  ops: [
    { id: 'm', type: 'mountain', shape: { kind: 'path', width: 300, points: [{ x: 0, z: 100 }, { x: 511, z: 120 }] }, params: { height: 50 } },
    { id: 'r', type: 'river', shape: { kind: 'path', width: 10, points: [{ x: 0, z: 300 }, { x: 511, z: 330 }] }, params: { start: 40, end: 34 } },
  ],
})
const threeD = compile({
  ...rolling,
  ops: [
    { id: 'c', type: 'cave', shape: { kind: 'path', width: 8, points: [{ x: 0, z: 16, y: 30 }, { x: 511, z: 16, y: 40 }] } },
    { id: 'a', type: 'arch', shape: { kind: 'path', width: 6, points: [{ x: 0, z: 10, y: 50 }, { x: 40, z: 20, y: 50 }] }, params: { rise: 12 } },
  ],
})
const out = new Uint16Array(32 * 32 * H)

describe('generateRegion, one 32 × 32 × 128 column', () => {
  bench('2D ops only (mountain, river, trees)', () => { generateRegion(twoD, 64, 96, 32, 32, out) })
  bench('with volume ops (cave, arch)', () => { generateRegion(threeD, 0, 0, 32, 32, out) })
})
