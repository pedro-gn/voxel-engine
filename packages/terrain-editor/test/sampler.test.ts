import { BRICK_VALUES, HEIGHT_VALUES, compileTerrain, sampleHeights } from '@elovox/terrain'
import { describe, expect, it } from 'vitest'
import { setParam } from '../src/core/edits.ts'
import { TerrainSampler } from '../src/core/sampler.ts'
import { HEIGHT, doc, flatDoc } from './fixtures.ts'

const o = { seed: 7, height: HEIGHT }

describe('TerrainSampler', () => {
  it('reads heights before the layer through the generation code', () => {
    const d = doc()
    const t = compileTerrain(d, { seed: 7, height: HEIGHT, id: () => 0 })
    expect(new TerrainSampler(o).heights(d, 60, 60, 8, 8)).toEqual(sampleHeights(t, 60, 60, 8, 8))
  })

  it('follows op changes, and layer changes do not move the heights', () => {
    const s = new TerrainSampler(o)
    const d = doc()
    const h0 = s.heights(d, 60, 60, 4, 4)
    const painted = { ...d, layers: { height: { tiles: [{ x: 0, z: 0, values: new Int16Array(HEIGHT_VALUES).fill(160) }] } } }
    expect(s.heights(painted, 60, 60, 4, 4)).toEqual(h0)
    expect(s.heights(setParam('hill', 'amplitude', 30)(d), 60, 60, 4, 4)).not.toEqual(h0)
  })

  it('reads density with the document\'s own layers', () => {
    const s = new TerrainSampler(o)
    const d = flatDoc()
    const g = { x0: 100, y0: 60, z0: 100, nx: 1, ny: 1, nz: 1, step: 2 }
    expect(s.density(d, g)[0]).toBe(-4) // air 30 blocks above the ground, clamped
    const values = new Int8Array(BRICK_VALUES)
    values[2 + 2 * 8 + 6 * 64] = 80 // sample (50, 30, 50) of brick (6, 3, 6) = block (100, 60, 100): +10 blocks
    expect(s.density({ ...d, layers: { density: { bricks: [{ x: 6, y: 3, z: 6, values }] } } }, g)[0]).toBe(6)
  })
})
