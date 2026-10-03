import { BIOME_TILE, type TerrainLayers } from '@elovox/terrain'
import { describe, expect, it } from 'vitest'
import { biomeDab } from '../src/core/biomeBrush.ts'
import { TileWriter } from '../src/core/layerWriter.ts'
import { flatDoc } from './fixtures.ts'

const cell = (l: TerrainLayers, cx: number, cz: number) => new TileWriter(l.biome?.tiles, BIOME_TILE, (n) => new Uint8Array(n)).get(cx, cz)

describe('biomeDab', () => {
  it('paints every cell whose centre lies within the radius', () => {
    // Centre (130, 130), radius 4: cell (32, 32) has its centre there; (31, 32) and (33, 32) are 4 away.
    const l = biomeDab(flatDoc(), { x: 130, z: 130, radius: 4, value: 2 })
    for (const [cx, cz] of [[31, 32], [32, 32], [33, 32], [32, 31], [32, 33]] as const) expect(cell(l, cx, cz)).toBe(2)
    expect(cell(l, 31, 31)).toBe(0)
    expect(cell(l, 34, 32)).toBe(0)
  })

  it('erases back to unpainted and drops the empty tile', () => {
    const painted = { ...flatDoc(), layers: biomeDab(flatDoc(), { x: 130, z: 130, radius: 4, value: 2 }) }
    expect(biomeDab(painted, { x: 130, z: 130, radius: 6, value: 0 }).biome).toBeUndefined()
  })

  it('stays inside the world and returns the same layers when nothing changes', () => {
    const l = biomeDab(flatDoc(), { x: 255, z: 255, radius: 8, value: 1 })
    expect(cell(l, 63, 63)).toBe(1)
    const d = { ...flatDoc(), layers: l }
    expect(biomeDab(d, { x: 255, z: 255, radius: 8, value: 1 })).toBe(d.layers)
  })
})
