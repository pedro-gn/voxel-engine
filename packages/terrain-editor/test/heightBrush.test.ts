import { HEIGHT_VALUES, TILE, type HeightTile, type TerrainDoc, type TerrainLayers } from '@elovox/terrain'
import { describe, expect, it } from 'vitest'
import { heightAt, heightDab } from '../src/core/heightBrush.ts'
import { TileWriter } from '../src/core/layerWriter.ts'
import { TerrainSampler } from '../src/core/sampler.ts'
import { HEIGHT, flatDoc } from './fixtures.ts'

const sampler = () => new TerrainSampler({ seed: 1, height: HEIGHT })
const value = (l: TerrainLayers, x: number, z: number) => new TileWriter(l.height?.tiles, TILE, (n) => new Int16Array(n)).get(x, z)
const hard = (radius: number, strength = 1) => ({ radius, strength, falloff: 0 })

/** Flat ground with a 10-block spike at column (100, 100). */
function spiked(): TerrainDoc {
  const values = new Int16Array(HEIGHT_VALUES)
  values[(100 - 64) + (100 - 64) * 64] = 160
  return { ...flatDoc(), layers: { height: { tiles: [{ x: 1, z: 1, values }] } } }
}

describe('heightDab', () => {
  it('raises every column within the radius by the weight, in 1/16 block', () => {
    const l = heightDab(flatDoc(), sampler(), { tool: 'raise', x: 128.5, z: 128.5, settings: hard(4) })
    expect(value(l, 128, 128)).toBe(16)
    expect(value(l, 132, 128)).toBe(16)
    expect(value(l, 133, 128)).toBe(0)
  })

  it('lowers when inverted, and fades with the falloff', () => {
    expect(value(heightDab(flatDoc(), sampler(), { tool: 'raise', x: 128.5, z: 128.5, settings: hard(4), invert: true }), 128, 128)).toBe(-16)
    const soft = heightDab(flatDoc(), sampler(), { tool: 'raise', x: 128.5, z: 128.5, settings: { radius: 8, strength: 1, falloff: 1 } })
    expect(value(soft, 132, 128)).toBe(8)
  })

  it('smooths toward the mean of the 3 × 3 neighbours', () => {
    // H = 40 at the spike, 30 around: the mean is 280 / 9; 160 + 16 · (280 / 9 − 40) ≈ 17.8 → 18.
    const l = heightDab(spiked(), sampler(), { tool: 'smooth', x: 100.5, z: 100.5, settings: hard(0.5) })
    expect(value(l, 100, 100)).toBe(18)
  })

  it('flattens toward the target and drops a tile left all zero', () => {
    const l = heightDab(spiked(), sampler(), { tool: 'flatten', x: 100.5, z: 100.5, settings: hard(0.5), target: 30 })
    expect(l.height).toBeUndefined()
  })

  it('clamps to the Int16 range and returns the same layers when nothing changes', () => {
    const values = new Int16Array(HEIGHT_VALUES)
    values[10 + 10 * 64] = 32767
    const d = { ...flatDoc(), layers: { height: { tiles: [{ x: 0, z: 0, values }] } } }
    expect(heightDab(d, sampler(), { tool: 'raise', x: 10.5, z: 10.5, settings: hard(0.5) })).toBe(d.layers)
  })

  it('shares untouched tiles and never mutates its input', () => {
    const a: HeightTile = { x: 0, z: 0, values: new Int16Array(HEIGHT_VALUES).fill(1) }
    const b: HeightTile = { x: 3, z: 3, values: new Int16Array(HEIGHT_VALUES).fill(2) }
    const d = { ...flatDoc(), layers: { height: { tiles: [a, b] } } }
    const l = heightDab(d, sampler(), { tool: 'raise', x: 10.5, z: 10.5, settings: hard(3) })
    expect(l.height!.tiles[1]).toBe(b)
    expect(l.height!.tiles[0]).not.toBe(a)
    expect(a.values[10 + 10 * 64]).toBe(1)
  })

  it('paints only inside the world at its edge, and ignores a dab outside it', () => {
    const l = heightDab(flatDoc(), sampler(), { tool: 'raise', x: 2, z: 2, settings: hard(8) })
    expect(value(l, 0, 0)).toBe(16)
    expect(l.height!.tiles.every((t) => t.x >= 0 && t.z >= 0)).toBe(true)
    const d = flatDoc()
    expect(heightDab(d, sampler(), { tool: 'raise', x: -50, z: -50, settings: hard(8) })).toBe(d.layers)
  })
})

describe('heightAt', () => {
  it('is the ground before the layer plus the layer', () => {
    expect(heightAt(spiked(), sampler(), 100.7, 100.2)).toBe(40)
    expect(heightAt(spiked(), sampler(), 5, 5)).toBe(30)
  })
})
