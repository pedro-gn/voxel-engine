import { describe, expect, it } from 'vitest'
import { validateTerrainDoc } from '../src/doc/validate.ts'
import { builtinOps } from '../src/ops/builtin.ts'
import { defineTerrainOp } from '../src/ops/registry.ts'
import { compileTerrain, type CompiledTerrain } from '../src/pipeline/compile.ts'
import { generateRegion } from '../src/pipeline/region.ts'
import { IDS, idOf, minimalDoc } from './fixtures.ts'

const H = 64
const WATER = IDS.water! | (7 << 12)

export function compileDoc(json: unknown, ops = builtinOps): CompiledTerrain {
  const r = validateTerrainDoc(json, { ops, worldHeight: H })
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return compileTerrain(r.doc, { seed: 99, height: H, id: idOf, ops })
}
function region(t: CompiledTerrain, x0: number, z0: number, w = 32, d = 32, features = false): (x: number, y: number, z: number) => number {
  const out = new Uint16Array(w * d * H)
  generateRegion(t, x0, z0, w, d, out, { features })
  return (x, y, z) => out[(x - x0) + (z - z0) * w + y * w * d]!
}
const column = (get: (x: number, y: number, z: number) => number, x: number, z: number) => Array.from({ length: H }, (_, y) => get(x, y, z))

describe('generateRegion: height, water and surface', () => {
  it('builds flat layered ground from the base and surface rules', () => {
    const get = region(compileDoc(minimalDoc()), 0, 0)
    const col = column(get, 5, 5)
    expect(col.slice(0, 16).every((v) => v === IDS.stone)).toBe(true)
    expect(col.slice(16, 19)).toEqual([IDS.dirt, IDS.dirt, IDS.dirt])
    expect(col[19]).toBe(IDS.grass)
    expect(col.slice(20).every((v) => v === 0)).toBe(true)
  })

  it('fills everything below sea level with water', () => {
    const get = region(compileDoc({ ...minimalDoc(), base: { height: 6, amplitude: 0, noise: { scale: 9 } } }), 0, 0)
    expect(column(get, 3, 3).slice(5, 11)).toEqual([IDS.grass, WATER, WATER, WATER, WATER, 0])
  })

  it('clamps heights to [1, height - 2] instead of throwing', () => {
    const t = compileDoc({ ...minimalDoc(), ops: [{ id: 'm', type: 'mountain', shape: { kind: 'circle', center: [16, 16], radius: 40 }, params: { height: 500, roughness: 0 } }] })
    const col = column(region(t, 0, 0), 16, 16)
    expect(col[H - 3]).not.toBe(0)
    expect(col[H - 2]).toBe(0)
  })

  it('applies height ops in document order', () => {
    const flat = (id: string, y: number) => ({ id, type: 'flatten', shape: { kind: 'circle', center: [16, 16], radius: 30 }, params: { y } })
    const t = compileDoc({ ...minimalDoc(), ops: [flat('a', 30), flat('b', 25)] })
    expect(column(region(t, 0, 0), 16, 16)[24]).toBe(IDS.grass)
  })

  it('places river water in its channel and sand on the banks via nearWater', () => {
    const doc = {
      ...minimalDoc(),
      biomes: [{ name: 'plain', surface: [{ block: 'sand', nearWater: 1, depth: [0, 1] }, { block: 'grass' }] }],
      ops: [{ id: 'r', type: 'river', shape: { kind: 'path', width: 6, points: [{ x: 0, z: 16 }, { x: 63, z: 16 }] }, params: { start: 19, end: 19, depth: 2, bank: 8, bankSlope: 0.5 } }],
    }
    const get = region(compileDoc(doc), 0, 0)
    const mid = column(get, 10, 16)
    expect(mid[18]).toBe(WATER)
    expect(mid[19]).toBe(0)
    expect(column(get, 10, 20).slice(18, 21)).toEqual([IDS.sand, IDS.sand, 0]) // bank top is at the water level (19), no wall beside the water
    expect(column(get, 10, 30)[19]).toBe(IDS.grass) // far from the river
  })

  it('leaves no water wall: water never has air beside it at the same height', () => {
    const cases = {
      river: { id: 'r', type: 'river', shape: { kind: 'path', width: 6, points: [{ x: 4, z: 16 }, { x: 60, z: 16 }] }, params: { start: 19, end: 19, depth: 2, bank: 8, bankSlope: 0.5 } },
      lake: { id: 'l', type: 'lake', shape: { kind: 'circle', center: [32, 32], radius: 14 }, params: { level: 19, depth: 4, shore: 10, shoreSlope: 0.5 } },
    }
    for (const [name, op] of Object.entries(cases)) {
      const w = 64, d = 64
      const out = new Uint16Array(w * d * H)
      generateRegion(compileDoc({ ...minimalDoc(), ops: [op] }), 0, 0, w, d, out, { features: false })
      const at = (x: number, y: number, z: number) => out[x + z * w + y * w * d]!
      let water = 0, walls = 0
      for (let y = 0; y < H; y++) for (let z = 0; z < d; z++) for (let x = 0; x < w; x++) {
        if (at(x, y, z) !== WATER) continue
        water++
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx, nz = z + dz
          if (nx >= 0 && nx < w && nz >= 0 && nz < d && at(nx, y, nz) === 0) walls++
        }
      }
      expect(water, name).toBeGreaterThan(0)
      expect(walls, name).toBe(0)
    }
  })

  it('carves volume ops through the ground and marks cave roofs as ceilings', () => {
    const doc = {
      ...minimalDoc(),
      biomes: [{ name: 'plain', surface: [{ block: 'rock', ceiling: true, depth: [0, 20] }, { block: 'grass' }, { block: 'dirt', depth: [1, 3] }] }],
      ops: [{ id: 'c', type: 'cave', shape: { kind: 'path', width: 6, points: [{ x: 0, z: 16, y: 10 }, { x: 63, z: 16, y: 10 }] }, params: { wobble: 0 } }],
    }
    const col = column(region(compileDoc(doc), 0, 0), 16, 16)
    expect(col[10]).toBe(0) // tunnel
    expect(col[14]).toBe(IDS.rock) // roof: air below
    expect(col[19]).toBe(IDS.grass)
  })

  it('adds a floating island above the ground, out-of-world parts clipped', () => {
    const doc = {
      ...minimalDoc(),
      ops: [
        { id: 'island', type: 'blob', shape: { kind: 'circle', center: [16, 16], radius: 8 }, params: { y: 40, height: 4, wobble: 0 } },
        { id: 'sky', type: 'blob', shape: { kind: 'circle', center: [0, 0], radius: 20 }, params: { y: 60, height: 10, wobble: 0 } },
      ],
    }
    const col = column(region(compileDoc(doc), 0, 0), 16, 16)
    expect(col[30]).toBe(0)
    expect(col[43]).toBe(IDS.grass) // island top: exposed, depth 0
    expect(col[38]).toBe(IDS.stone)
  })

  it('names the op when it throws, with the columns it was working on', () => {
    const boom = defineTerrainOp({
      type: 'boom', kind: 'height', defaultBlend: 'add', shapes: ['circle'],
      validate() {},
      compile(def) { return { id: def.id, bounds: { x0: 0, z0: 0, x1: 100, z1: 100 }, apply() { throw new Error('kaboom') } } },
    })
    const ops = builtinOps.with(boom)
    const t = compileDoc({ ...minimalDoc(), ops: [{ id: 'bad', type: 'boom', shape: { kind: 'circle', center: [1, 1], radius: 1 } }] }, ops)
    expect(() => region(t, 32, 0)).toThrow('op "bad" failed at columns x 31..64, z 0..32: kaboom')
  })

  it('reports an unregistered block by name', () => {
    expect(() => compileDoc({ ...minimalDoc(), biomes: [{ name: 'plain', surface: [{ block: 'lava' }] }] })).toThrow('the terrain document uses block "lava", which is not registered')
  })

  it('checks the buffer size', () => {
    expect(() => generateRegion(compileDoc(minimalDoc()), 0, 0, 32, 32, new Uint16Array(10))).toThrow(RangeError)
  })
})
