import { describe, expect, it } from 'vitest'
import { validateTerrainDoc } from '../src/doc/validate.ts'
import { BRICK_VALUES, HEIGHT_VALUES } from '../src/layers/tiles.ts'
import { fillCells } from '../src/pipeline/cells.ts'
import { compileTerrain, type CompiledTerrain } from '../src/pipeline/compile.ts'
import { generateRegion } from '../src/pipeline/region.ts'
import { sampleDensity, sampleHeights, withLayers } from '../src/pipeline/sample.ts'
import { IDS, idOf, minimalDoc } from './fixtures.ts'

const H = 64
const WATER = IDS.water! | (7 << 12)

function compileDoc(json: unknown): CompiledTerrain {
  const r = validateTerrainDoc(json, { worldHeight: H })
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return compileTerrain(r.doc, { seed: 99, height: H, id: idOf })
}
function region(t: CompiledTerrain): (x: number, y: number, z: number) => number {
  const out = new Uint16Array(64 * 64 * H)
  generateRegion(t, 0, 0, 64, 64, out, { features: false })
  return (x, y, z) => out[x + z * 64 + y * 64 * 64]!
}

describe('density clamp', () => {
  it('lets a brush change solidity by the same amount at any depth', () => {
    const deep = new Int8Array(BRICK_VALUES)
    deep[2 + 2 * 8 + 5 * 64] = -40 // block (4, 10, 4): 50 below the ground, -5 blocks
    const surface = new Int8Array(BRICK_VALUES)
    surface[2 + 2 * 8 + 5 * 64] = -40 // block (4, 58, 4): just under the ground
    surface[2 + 2 * 8 + 7 * 64] = 40 // block (4, 62, 4): in the air above it, +5 blocks
    const t = compileDoc({
      ...minimalDoc(), base: { height: 60, amplitude: 0, noise: { scale: 32 } },
      layers: { density: { bricks: [{ x: 0, y: 0, z: 0, values: deep }, { x: 0, y: 3, z: 0, values: surface }] } },
    })
    const get = region(t)
    expect(get(4, 10, 4)).toBe(0)
    expect(get(4, 58, 4)).toBe(0)
    expect(get(4, 62, 4)).not.toBe(0)
    expect(get(4, 30, 4)).toBe(IDS.stone)
    expect(get(10, 10, 10)).toBe(IDS.stone)
  })
})

describe('sampleHeights', () => {
  it('is the ground before the height layer', () => {
    const t = compileDoc({
      ...minimalDoc(),
      ops: [{ id: 'h', type: 'hills', shape: { kind: 'circle', center: [32, 32], radius: 20 }, params: { amplitude: 10 } }],
      layers: { height: { tiles: [{ x: 0, z: 0, values: new Int16Array(HEIGHT_VALUES).fill(32) }] } }, // +2 blocks
    })
    const h = sampleHeights(t, 20, 20, 8, 8)
    const cells = fillCells(t, 20, 20, 8, 8)
    for (let i = 0; i < 64; i++) expect(cells.top[i]).toBe(Math.min(H - 2, Math.max(1, Math.round(h[i]! + 2))))
  })
})

describe('sampleDensity', () => {
  it('is positive exactly where the pipeline puts solid voxels', () => {
    const values = new Int8Array(BRICK_VALUES).fill(-24) // -3 blocks over the whole brick
    const t = compileDoc({
      ...minimalDoc(),
      ops: [{ id: 'b', type: 'blob', shape: { kind: 'circle', center: [20, 20], radius: 6 }, params: { y: 30, height: 5 } }],
      layers: { density: { bricks: [{ x: 1, y: 1, z: 1, values }] } },
    })
    const d = sampleDensity(t, { x0: 4, y0: 4, z0: 4, nx: 16, ny: 20, nz: 16, step: 2 })
    const get = region(t)
    for (let j = 0; j < 20; j++) for (let k = 0; k < 16; k++) for (let i = 0; i < 16; i++) {
      const v = get(4 + i * 2, 4 + j * 2, 4 + k * 2)
      expect(d[i + k * 16 + j * 256]! > 0).toBe(v !== 0 && v !== WATER)
    }
  })

  it('reads the nearest y inside the world for points outside it', () => {
    const t = compileDoc(minimalDoc())
    const d = sampleDensity(t, { x0: 0, y0: -4, z0: 0, nx: 1, ny: 2, nz: 1, step: 4 }) // y -4 and 0
    expect(d[0]).toBe(d[1])
  })
})

describe('withLayers', () => {
  it('swaps the layers and keeps everything else', () => {
    const t = compileDoc(minimalDoc())
    const values = new Int16Array(HEIGHT_VALUES).fill(16)
    const u = withLayers(t, { height: { tiles: [{ x: 0, z: 0, values }] } })
    expect(u.heightLayer.at(3, 3)).toBe(1)
    expect(t.heightLayer.empty).toBe(true)
    expect(u.heightOps).toBe(t.heightOps)
  })
})
