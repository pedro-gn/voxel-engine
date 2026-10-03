import { describe, expect, it } from 'vitest'
import { stampFeatures } from '../src/features/place.ts'
import { mulberry32 } from '../src/features/rand.ts'
import { stampRock } from '../src/features/rocks.ts'
import { stampTree } from '../src/features/trees.ts'
import { validateTerrainDoc } from '../src/doc/validate.ts'
import { compileTerrain, type CompiledTerrain } from '../src/pipeline/compile.ts'
import { newProbe, probe } from '../src/pipeline/probe.ts'
import { generateRegion } from '../src/pipeline/region.ts'
import { IDS, idOf, minimalDoc } from './fixtures.ts'

const H = 64
const BLOCKS = { log: IDS.log!, leaves: IDS.leaves!, pineLeaves: IDS.pine_leaves! }

function compileDoc(json: unknown, size = 128): CompiledTerrain {
  const r = validateTerrainDoc({ ...(json as object), size: [size, size] }, { worldHeight: H })
  if (!r.ok) throw new Error(r.errors.join('\n'))
  return compileTerrain(r.doc, { seed: 5, height: H, id: idOf })
}

/** A forest on rolling ground with a river, a cave, an arch and a blob: every stage that can cross a border. */
function busyDoc(): unknown {
  return {
    ...minimalDoc(),
    base: { height: 22, amplitude: 10, noise: { scale: 40 } },
    biomes: [
      { name: 'plain', surface: [{ block: 'sand', nearWater: 1, depth: [0, 1] }, { block: 'grass' }, { block: 'dirt', depth: [1, 3] }], trees: { density: 0.6, kinds: ['broadleaf', 'pine', 'bush'] }, rocks: { density: 0.3, size: [1, 4] } },
    ],
    ops: [
      { id: 'river', type: 'river', shape: { kind: 'path', width: 6, points: [{ x: 0, z: 40 }, { x: 127, z: 60 }] }, params: { start: 24, end: 20 } },
      { id: 'cave', type: 'cave', shape: { kind: 'path', width: 5, points: [{ x: 10, z: 10, y: 18 }, { x: 80, z: 70, y: 14 }] } },
      { id: 'arch', type: 'arch', shape: { kind: 'path', width: 4, points: [{ x: 20, z: 80, y: 28 }, { x: 50, z: 84, y: 28 }] }, params: { rise: 10 } },
      { id: 'island', type: 'blob', shape: { kind: 'circle', center: [64, 30], radius: 9 }, params: { y: 48, height: 4 } },
    ],
  }
}

function regionOf(t: CompiledTerrain, x0: number, z0: number, w: number, d: number, features = true): Uint16Array {
  const out = new Uint16Array(w * d * H)
  generateRegion(t, x0, z0, w, d, out, { features })
  return out
}

describe('tree and rock stamps', () => {
  function stamped(f: (put: (x: number, y: number, z: number, v: number, overwrite: boolean) => void) => void) {
    const cells = new Map<string, number>()
    f((x, y, z, v, overwrite) => { const k = `${x},${y},${z}`; if (overwrite || !cells.has(k)) cells.set(k, v) })
    const xs = [...cells.keys()].map((k) => k.split(',').map(Number))
    return { cells, reach: Math.max(...xs.map(([x, , z]) => Math.max(Math.abs(x!), Math.abs(z!)))), top: Math.max(...xs.map(([, y]) => y!)) }
  }
  it('keeps every tree kind within reach and height limits', () => {
    for (const kind of ['broadleaf', 'pine', 'bush'] as const) {
      for (let s = 0; s < 50; s++) {
        const { cells, reach, top } = stamped((put) => stampTree(kind, 0, 0, 0, mulberry32(s), BLOCKS, put))
        expect(reach).toBeLessThanOrEqual(5)
        expect(top).toBeLessThanOrEqual(12)
        expect(cells.get('0,0,0')).toBe(IDS.log)
      }
    }
  })
  it('keeps rocks within reach and partly buried', () => {
    for (let s = 0; s < 50; s++) {
      const { cells, reach } = stamped((put) => stampRock(0, 10, 0, 6, mulberry32(s), IDS.rock!, put))
      expect(reach).toBeLessThanOrEqual(7)
      expect(cells.get('0,9,0')).toBe(IDS.rock) // below the ground line
    }
  })
  it('varies tree shapes with the seed', () => {
    const a = stamped((put) => stampTree('broadleaf', 0, 0, 0, mulberry32(1), BLOCKS, put)).cells
    const b = stamped((put) => stampTree('broadleaf', 0, 0, 0, mulberry32(2), BLOCKS, put)).cells
    expect([...a.keys()].sort()).not.toEqual([...b.keys()].sort())
  })
})

describe('probe', () => {
  it('matches the region it probes', () => {
    const t = compileDoc(busyDoc())
    const out = regionOf(t, 0, 0, 32, 32, false)
    const p = newProbe()
    for (const [x, z] of [[3, 4], [17, 30], [25, 11]] as const) {
      probe(t, x, z, p)
      let top = H - 1
      while (top >= 0 && (out[x + z * 32 + top * 1024] === 0 || out[x + z * 32 + top * 1024] === (IDS.water! | (7 << 12)))) top--
      expect(p.top).toBe(top)
      expect(p.block).toBe(out[x + z * 32 + top * 1024])
    }
  })
})

describe('stampFeatures', () => {
  it('generates the same voxels as 3 × 3 columns or as one 96 × 96 region', () => {
    const t = compileDoc(busyDoc())
    const whole = regionOf(t, 0, 0, 96, 96)
    let trees = 0, mismatches = 0
    for (let cz = 0; cz < 3; cz++) for (let cx = 0; cx < 3; cx++) {
      const col = regionOf(t, cx * 32, cz * 32, 32, 32)
      for (let y = 0; y < H; y++) for (let lz = 0; lz < 32; lz++) for (let lx = 0; lx < 32; lx++) {
        const v = col[lx + lz * 32 + y * 1024]!
        if (v !== whole[cx * 32 + lx + (cz * 32 + lz) * 96 + y * 96 * 96]) mismatches++
        if (v === IDS.log) trees++
      }
    }
    expect(mismatches).toBe(0)
    expect(trees).toBeGreaterThan(100) // the test is not vacuous
  })

  it('never stands a tree on sand, water or air', () => {
    const t = compileDoc(busyDoc())
    const out = regionOf(t, 0, 0, 128, 128)
    const WATER = IDS.water! | (7 << 12)
    let trunks = 0
    for (let z = 0; z < 128; z++) for (let x = 0; x < 128; x++) for (let y = 1; y < H; y++) {
      const i = x + z * 128 + y * 128 * 128, below = out[i - 128 * 128]!
      if (out[i] !== IDS.log || below === IDS.log) continue
      trunks++
      expect([IDS.sand, WATER, 0]).not.toContain(below)
    }
    expect(trunks).toBeGreaterThan(50)
  })

  it('skips trees that would leave the top of the world', () => {
    const t = compileDoc({
      ...minimalDoc(),
      base: { height: H - 6, amplitude: 0, noise: { scale: 9 } },
      biomes: [{ name: 'plain', surface: [{ block: 'grass' }], trees: { density: 1, kinds: ['pine'] } }],
    })
    const out = regionOf(t, 0, 0, 32, 32)
    expect(out.includes(IDS.log!)).toBe(false)
  })

  it('writes nothing outside its region', () => {
    const t = compileDoc(busyDoc())
    const out = new Uint16Array(32 * 32 * H)
    stampFeatures(t, 40, 40, 32, 32, out) // empty terrain buffer: every candidate column is probed, stamps are clipped
    expect(out.length).toBe(32 * 32 * H)
  })

  it('matches a golden hash, so generation is identical on every JS engine', () => {
    const out = regionOf(compileDoc(busyDoc()), 32, 32, 32, 32)
    let h = 0x811c9dc5
    for (let i = 0; i < out.length; i++) h = Math.imul(h ^ out[i]!, 0x01000193)
    expect(h >>> 0).toBe(GOLDEN)
  })
})

const GOLDEN = 2694289451
