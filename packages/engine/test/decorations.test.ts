import { describe, expect, it } from 'vitest'
import { BlockRegistry, defineBlock } from '../src/blocks/registry.ts'
import { MeshJobRunner } from '../src/mesh/meshJob.ts'
import { hexToLinear } from '../src/render/atmosphere.ts'
import { DecorationRegistry, MAX_DECORATIONS, defineDecoration } from '../src/render/decorations/defs.ts'
import { EDGE, InstanceBuilder, extractDecorations, flowerChanceAt, packInstance, unpackInstance } from '../src/render/decorations/extract.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ChunkStore } from '../src/world/chunkStore.ts'
import { packLight } from '../src/world/voxel.ts'
import { padIndex, type ChunkSnapshot } from '../src/world/reader.ts'
import { ID, TEST_BLOCKS } from './helpers.ts'
import { decoratedMeshTables } from './meshFixtures.ts'
import { emptySnap, put } from './meshHelpers.ts'

function run(s: ChunkSnapshot, tables = decoratedMeshTables(), origin: [number, number, number] = [0, 0, 0]) {
  const g = new InstanceBuilder(), f = new InstanceBuilder()
  extractDecorations(s, tables, origin[0], origin[1], origin[2], g, f)
  return { grass: g.build(), flowers: f.build() }
}
const instances = (a: Uint32Array | null) => {
  const out: ReturnType<typeof unpackInstance>[] = []
  if (a) for (let i = 0; i < a.length; i += 2) out.push(unpackInstance(a[i]!))
  return out
}

describe('DecorationRegistry', () => {
  const blocks = () => new BlockRegistry([defineBlock({ name: 'grass', decoration: 'meadow' }), defineBlock({ name: 'stone' })])
  it('resolves defaults and maps blocks to decorations', () => {
    const r = new DecorationRegistry([defineDecoration({ name: 'meadow', grass: {} })], blocks())
    expect(r.defs[0]!.grass).toEqual({ blades: 16, height: [0.25, 0.55], base: hexToLinear('#4f8a2e'), tip: hexToLinear('#a9d65a'), overhang: 0.2 })
    expect(r.defs[0]!.flowers).toBeNull()
    expect([...r.tables.byBlock]).toEqual([0, 1, 0])
    expect([...r.tables.grass]).toEqual([1])
    expect(r.id('meadow')).toBe(0)
  })
  it('rejects a block naming an undefined decoration', () => {
    expect(() => new DecorationRegistry([], blocks())).toThrow(/block "grass" names decoration "meadow", which is not defined/)
  })
  it('validates definitions', () => {
    const b = new BlockRegistry([defineBlock({ name: 'stone' })])
    const bad = (d: object) => () => new DecorationRegistry([{ name: 'x', ...d }], b)
    expect(bad({ grass: { blades: 0 } })).toThrow(/blades/)
    expect(bad({ grass: { blades: 25 } })).toThrow(/blades/)
    expect(bad({ grass: { height: [0.6, 0.3] } })).toThrow(/height/)
    expect(bad({ grass: { base: 'green' } })).toThrow(/base/)
    expect(bad({ grass: { overhang: 0.9 } })).toThrow(/overhang/)
    expect(bad({ flowers: { chance: 2 } })).toThrow(/chance/)
    expect(bad({ flowers: { colors: [] } })).toThrow(/colors/)
    expect(bad({ flowers: { colors: new Array(9).fill('#ffffff') } })).toThrow(/colors/)
    expect(() => new DecorationRegistry([{ name: 'a' }, { name: 'a' }], b)).toThrow(/duplicate decoration "a"/)
    expect(() => new DecorationRegistry(Array.from({ length: MAX_DECORATIONS + 1 }, (_, i) => ({ name: `d${i}` })), b)).toThrow(/too many decorations/)
  })
})

describe('instance packing', () => {
  it('round-trips every field', () => {
    expect(unpackInstance(packInstance(31, 17, 5, 9, 15, 3))).toEqual({ lx: 31, ly: 17, lz: 5, edge: 9, sky: 15, blk: 3 })
  })
})

describe('extractDecorations', () => {
  it('emits one grass instance per decorated top with air above, lit by the voxel above', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, ID.grass)
    s.light[padIndex(5, 6, 5)] = packLight(12, 3)
    put(s, 8, 4, 4, ID.grass)
    put(s, 8, 5, 4, ID.stone) // covered: no tuft
    put(s, 12, 4, 4, ID.dirt) // not decorated
    const g = instances(run(s).grass)
    expect(g).toHaveLength(1)
    expect(g[0]).toMatchObject({ lx: 4, ly: 4, lz: 4, sky: 12, blk: 3 })
  })
  it('sets edge bits where the same-height neighbour is not opaque', () => {
    const s = emptySnap()
    put(s, 4, 4, 4, ID.grass)
    put(s, 5, 4, 4, ID.stone) // +x covered
    put(s, 4, 4, 5, ID.grass) // +z covered by another grass block
    put(s, 3, 4, 4, ID.glass) // −x: glass is not opaque → edge
    const g = instances(run(s).grass).find((i) => i.lx === 4 && i.lz === 4)!
    expect(g.edge).toBe(EDGE.NX | EDGE.NZ)
  })
  it('reads edge neighbours across the chunk border from the padding (Review Focus 1)', () => {
    const s = emptySnap()
    put(s, 31, 4, 10, ID.grass)
    expect(instances(run(s).grass)[0]!.edge & EDGE.PX).toBe(EDGE.PX) // padding x = 32 is air
    put(s, 32, 4, 10, ID.stone)
    expect(instances(run(s).grass)[0]!.edge & EDGE.PX).toBe(0)
  })
  it('hangs over the world edge: out-of-world neighbours are air (Review Focus 5)', () => {
    const s = emptySnap() // the padding of a world-edge chunk holds air
    put(s, 0, 4, 0, ID.grass)
    put(s, 1, 4, 0, ID.stone)
    put(s, 0, 4, 1, ID.stone)
    expect(instances(run(s).grass)[0]!.edge).toBe(EDGE.NX | EDGE.NZ)
  })
  it('places flowers deterministically inside patches only', () => {
    const s = emptySnap()
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) put(s, x, 4, z, ID.grass)
    const a = run(s, decoratedMeshTables(), [64, 0, 96])
    const b = run(s, decoratedMeshTables(), [64, 0, 96])
    expect(a).toEqual(b)
    const f = instances(a.flowers)
    expect(f.length).toBeGreaterThan(0)
    expect(f.length).toBeLessThan(32 * 32)
    for (const i of f) expect(flowerChanceAt(1, 12, 64 + i.lx, 96 + i.lz)).toBeGreaterThan(0)
    for (let k = 1; k < a.flowers!.length; k += 2) {
      expect(a.flowers![k]! & 255).toBe(0) // decoration index
      expect(a.flowers![k]! >>> 8).toBeLessThan(5) // colour index < MEADOW's 5 default colours
    }
  })
  it('emits no grass for a flowers-only decoration', () => {
    const tables = decoratedMeshTables([defineDecoration({ name: 'blooms', flowers: { chance: 1 } })])
    const s = emptySnap()
    for (let x = 0; x < 32; x++) put(s, x, 4, 0, ID.grass)
    expect(run(s, tables).grass).toBeNull()
  })
})

describe('MeshJobRunner decorations (Review Focus 2)', () => {
  it('drops a tuft as soon as a ghost block covers it', () => {
    const reg = new BlockRegistry(TEST_BLOCKS.map((b) => (b.name === 'grass' ? { ...b, decoration: 'meadow' } : b)))
    const buffers = createWorldBuffers([64, 64, 64])
    const runner = new MeshJobRunner(buffers, decoratedMeshTables())
    const store = new ChunkStore({ buffers, opaque: reg.opaque, onNewPage: (i, p) => runner.addPage(i, p) })
    store.setVoxel(3, 3, 3, ID.grass)
    store.commit()
    const before = runner.run({ id: 1, chunk: 0 })
    const after = runner.run({ id: 2, chunk: 0, overrides: [[3, 4, 3, ID.stone]] })
    if (before.type !== 'result' || after.type !== 'result') throw new Error('expected results')
    expect(before.data.grass).not.toBeNull()
    expect(after.data.grass).toBeNull()
  })
})

describe('stateDensity', () => {
  const YOUNG = defineDecoration({ name: 'meadow', grass: {}, stateDensity: [1, 2 / 3, 1 / 3, 0] })
  const plane = (state: number) => {
    const s = emptySnap()
    for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) put(s, x, 4, z, (state << 12) | ID.grass)
    return s
  }
  const count = (state: number) => instances(run(plane(state), decoratedMeshTables([YOUNG])).grass).length
  it('keeps every tuft at state 0, none at state 3, and about a third at state 2', () => {
    expect(count(0)).toBe(1024)
    expect(count(3)).toBe(0)
    const third = count(2)
    expect(third).toBeGreaterThan(1024 * 0.25)
    expect(third).toBeLessThan(1024 * 0.42)
  })
  it('is deterministic per block and nested: a block shown at 1/3 is also shown at 2/3', () => {
    const at = (state: number) => new Set(instances(run(plane(state), decoratedMeshTables([YOUNG])).grass).map((i) => i.lx + i.lz * 32))
    const a = at(2), b = at(1)
    for (const k of a) expect(b.has(k)).toBe(true)
  })
  it('validates stateDensity', () => {
    const b = new BlockRegistry([defineBlock({ name: 'stone' })])
    expect(() => new DecorationRegistry([{ name: 'x', stateDensity: [1, 2, 0, 0] as unknown as [number, number, number, number] }], b)).toThrow(/stateDensity/)
    expect(() => new DecorationRegistry([{ name: 'x', stateDensity: [1, 1] as unknown as [number, number, number, number] }], b)).toThrow(/stateDensity/)
  })
})
