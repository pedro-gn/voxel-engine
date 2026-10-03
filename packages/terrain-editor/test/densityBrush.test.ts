import { BRICK_VALUES, validateTerrainDoc, type TerrainDoc, type TerrainLayers } from '@elovox/terrain'
import { describe, expect, it } from 'vitest'
import { biomeDab } from '../src/core/biomeBrush.ts'
import { densityDab } from '../src/core/densityBrush.ts'
import { heightDab } from '../src/core/heightBrush.ts'
import { BrickWriter } from '../src/core/layerWriter.ts'
import { TerrainSampler } from '../src/core/sampler.ts'
import { HEIGHT, SIZE, doc, flatDoc } from './fixtures.ts'

const sampler = () => new TerrainSampler({ seed: 1, height: HEIGHT })
const sample = (l: TerrainLayers, sx: number, sy: number, sz: number) => new BrickWriter(l.density?.bricks).get(sx, sy, sz)
const hard = (radius: number) => ({ radius, strength: 1, falloff: 0 })

/** Flat ground at 30 with one density sample: (50, 30, 50) = block (100, 60, 100). */
function withSample(v: number): TerrainDoc {
  const values = new Int8Array(BRICK_VALUES)
  values[2 + 2 * 8 + 6 * 64] = v
  return { ...flatDoc(), layers: { density: { bricks: [{ x: 6, y: 3, z: 6, values }] } } }
}

describe('densityDab', () => {
  it('adds 2 blocks × weight to the samples within the radius', () => {
    const l = densityDab(flatDoc(), sampler(), { tool: 'add', x: 100, y: 60, z: 100, settings: hard(1) })
    expect(sample(l, 50, 30, 50)).toBe(16)
    expect(sample(l, 51, 30, 50)).toBe(0)
  })

  it('carves when inverted and clamps to the Int8 range', () => {
    const l = densityDab(withSample(-120), sampler(), { tool: 'add', x: 100, y: 60, z: 100, settings: hard(1), invert: true })
    expect(sample(l, 50, 30, 50)).toBe(-128)
  })

  it('removes a brick that ends up all zero', () => {
    const d = flatDoc()
    const s = sampler()
    const added = { ...d, layers: densityDab(d, s, { tool: 'add', x: 100, y: 60, z: 100, settings: hard(1) }) }
    expect(densityDab(added, s, { tool: 'add', x: 100, y: 60, z: 100, settings: hard(1), invert: true }).density).toBeUndefined()
  })

  it('smooths toward the mean of the 3 × 3 × 3 total density', () => {
    // Air around (density −4); the sample itself is −4 + 10 = 6. Mean (6 − 26 · 4) / 27; 80 + 8 · (mean − 6) ≈ 2.96 → 3.
    const l = densityDab(withSample(80), sampler(), { tool: 'smooth', x: 100, y: 60, z: 100, settings: hard(1) })
    expect(sample(l, 50, 30, 50)).toBe(3)
  })

  it('paints only inside the world, and ignores a dab outside it', () => {
    const l = densityDab(flatDoc(), sampler(), { tool: 'add', x: 0, y: 0, z: 0, settings: hard(6) })
    expect(sample(l, 0, 0, 0)).toBe(16)
    expect(l.density!.bricks.every((b) => b.x >= 0 && b.y >= 0 && b.z >= 0)).toBe(true)
    const d = flatDoc()
    expect(densityDab(d, sampler(), { tool: 'add', x: -100, y: 60, z: -100, settings: hard(4) })).toBe(d.layers)
  })
})

describe('brushes keep the document valid', () => {
  it('any seeded sequence of dabs yields a normalized document validateTerrainDoc accepts', () => {
    let seed = 12345
    const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296
    const s = sampler()
    let d = doc()
    for (let step = 0; step < 150; step++) {
      const settings = { radius: 1 + rand() * 30, strength: rand(), falloff: rand() }
      const x = -20 + rand() * (SIZE[0] + 40), z = -20 + rand() * (SIZE[1] + 40), y = -10 + rand() * (HEIGHT + 20)
      const invert = rand() < 0.5
      let layers: TerrainLayers
      switch (Math.floor(rand() * 6)) {
        case 0: layers = heightDab(d, s, { tool: 'raise', x, z, settings, invert }); break
        case 1: layers = heightDab(d, s, { tool: 'smooth', x, z, settings }); break
        case 2: layers = heightDab(d, s, { tool: 'flatten', x, z, settings, target: rand() * 200 - 50 }); break
        case 3: layers = biomeDab(d, { x, z, radius: settings.radius, value: Math.floor(rand() * (d.biomes.length + 1)) }); break
        case 4: layers = densityDab(d, s, { tool: 'add', x, y, z, settings, invert }); break
        default: layers = densityDab(d, s, { tool: 'smooth', x, y, z, settings })
      }
      d = { ...d, layers }
    }
    const r = validateTerrainDoc(d, { worldHeight: HEIGHT })
    expect(r.ok ? [] : r.errors).toEqual([])
    expect(r.ok && r.doc.layers).toEqual(d.layers) // already sorted, with no all-zero tile
  })
})
