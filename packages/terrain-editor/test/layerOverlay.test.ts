import { BIOME_VALUES, HEIGHT_VALUES, type TerrainLayers } from '@elovox/terrain'
import { Color } from 'three/webgpu'
import { describe, expect, it } from 'vitest'
import { biomeColor, heightColor } from '../src/ui/brushes/colors.ts'
import { LayerOverlay } from '../src/ui/brushes/layerOverlay.ts'
import { LIFT } from '../src/ui/handles/overlay.ts'

/** A colour after the mesh's round trip: sRGB hex → linear floats stored as Float32 → hex. */
function hex(c: number): number {
  const col = new Color().setHex(c)
  const f = Float32Array.of(col.r, col.g, col.b)
  return new Color(f[0], f[1], f[2]).getHex()
}

describe('LayerOverlay', () => {
  const biome = new Uint8Array(BIOME_VALUES)
  biome[0] = 1 // cell (16, 0) of tile (1, 0): centre (66, 2)
  biome[3 + 2 * 16] = 2 // cell (19, 2): centre (78, 10)
  biome[15 + 15 * 16] = 2
  const height = new Int16Array(HEIGHT_VALUES)
  height[5 + 6 * 64] = -64 // column (5, 6): the 4 × 4 block (1, 1), centre (6, 6), −4 blocks
  const layers: TerrainLayers = {
    biome: { tiles: [{ x: 1, z: 0, values: biome }] },
    height: { tiles: [{ x: 0, z: 0, values: height }] },
  }

  it('draws one quad per painted biome cell, on the ground, in its biome colour', () => {
    const o = new LayerOverlay(() => 30)
    o.draw(layers, 'biome')
    expect(o.count).toBe(3)
    const q = o.quad(0)
    expect(q).toMatchObject({ x: 66, z: 2, color: hex(biomeColor(1)) })
    expect(q.y).toBeCloseTo(30 + LIFT / 2, 4) // instance matrices are Float32
    expect(o.quad(1)).toMatchObject({ x: 78, z: 10, color: hex(biomeColor(2)) })
  })

  it('draws one quad per 4 × 4 columns holding a height delta, tinted by its largest value', () => {
    const o = new LayerOverlay(() => 30)
    o.draw(layers, 'height')
    expect(o.count).toBe(1)
    expect(o.quad(0)).toMatchObject({ x: 6, z: 6, color: hex(heightColor(-4)) })
  })

  it('clears for no mode, and each draw replaces the last', () => {
    const o = new LayerOverlay(() => 30)
    o.draw(layers, 'biome')
    o.draw(layers, null)
    expect(o.count).toBe(0)
    expect(o.group.children).toHaveLength(0)
    o.draw({}, 'height')
    expect(o.count).toBe(0)
  })
})
