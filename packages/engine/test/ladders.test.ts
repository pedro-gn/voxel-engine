import { describe, expect, it } from 'vitest'
import { BlockRegistry, defineBlock } from '../src/blocks/registry.ts'
import { SHAPE, ladderState, shapeBoxes, turnShapeState, type Facing } from '../src/blocks/shapes.ts'
import { Mesher } from '../src/mesh/mesher.ts'
import { meshTablesFrom } from '../src/mesh/tables.ts'
import { FACE_NORMALS, unpackA, unpackB } from '../src/mesh/vertexFormat.ts'
import { LightEngine } from '../src/sim/light.ts'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { ChunkStore } from '../src/world/chunkStore.ts'
import { blockLight, packVoxel } from '../src/world/voxel.ts'
import { ID, LADDER_ID, SHAPED_TEST_BLOCKS, TEST_BLOCKS, ladderRegistry, testRegistry } from './helpers.ts'
import { emptySnap, put } from './meshHelpers.ts'

const STRAIGHT = { kind: 'straight' } as const

describe('climbable blocks', () => {
  it('accepts a climbable ladder and a non-solid shaped torch', () => {
    const reg = ladderRegistry()
    expect(reg.id('ladder')).toBe(LADDER_ID.ladder)
    expect(reg.id('torch_post')).toBe(LADDER_ID.torch_post)
    expect(reg.climbable[LADDER_ID.ladder]).toBe(1)
    expect(reg.climbable[LADDER_ID.torch_post]).toBe(0)
    expect(reg.hasClimbable).toBe(true)
    expect(reg.blocksLight[LADDER_ID.ladder]).toBe(0)
    expect(reg.blocksLight[LADDER_ID.torch_post]).toBe(0)
    expect(reg.solid[LADDER_ID.torch_post]).toBe(0)
    expect(reg.solid[LADDER_ID.ladder]).toBe(0)
    expect(reg.shape[LADDER_ID.ladder]).toBe(SHAPE.LADDER)
  })
  it('refuses a climbable block that is solid or liquid', () => {
    expect(() => new BlockRegistry([defineBlock({ name: 'rope', climbable: true })])).toThrow(/rope/)
    expect(() => new BlockRegistry([defineBlock({ name: 'rope', climbable: true })])).toThrow(RangeError)
    expect(() => new BlockRegistry([defineBlock({ name: 'vine_water', climbable: true, liquid: true, solid: false })])).toThrow(/vine_water/)
  })
  it('has no climbable without a climbable def', () => {
    expect(testRegistry().hasClimbable).toBe(false)
    expect(new BlockRegistry([...TEST_BLOCKS, ...SHAPED_TEST_BLOCKS]).climbable.every((c) => c === 0)).toBe(true)
  })
})

describe('the ladder shape', () => {
  /** Distance of a box from side f (0 +x, 1 +z, 2 −x, 3 −z) of the cell, in sixteenths. */
  const fromSide = (b: readonly number[], f: Facing) => (f === 0 ? 16 - b[0]! : f === 1 ? 16 - b[2]! : f === 2 ? b[3]! : b[5]!)
  it('hangs every box within 2/16 of the side it faces', () => {
    for (const f of [0, 1, 2, 3] as const) {
      const bs = shapeBoxes(SHAPE.LADDER, ladderState(f), STRAIGHT)
      expect(bs.length).toBeGreaterThanOrEqual(3)
      for (const b of bs) expect(fromSide(b, f)).toBeLessThanOrEqual(2)
    }
  })
  it('turns like a stair: the four facings are rotations of each other', () => {
    expect(turnShapeState('ladder', ladderState(0), 1)).toBe(ladderState(1))
    expect(turnShapeState('ladder', ladderState(3), 1)).toBe(ladderState(0))
    expect(turnShapeState('ladder', ladderState(1), -1)).toBe(ladderState(0))
    const turn = (b: readonly number[]) => [16 - b[5]!, b[1]!, b[0]!, 16 - b[2]!, b[4]!, b[3]!].join(',') // +x → +z
    for (const f of [0, 1, 2, 3] as const) {
      const next = ((f + 1) & 3) as Facing
      const turned = shapeBoxes(SHAPE.LADDER, ladderState(f), STRAIGHT).map(turn).sort()
      expect(turned).toEqual(shapeBoxes(SHAPE.LADDER, ladderState(next), STRAIGHT).map((b) => b.join(',')).sort())
    }
  })
})

describe('ladders and torches in the mesh and the light', () => {
  const reg = ladderRegistry()
  const tables = meshTablesFrom(reg, reg.faceLayers(new Map(reg.textureNames().map((n, i) => [n, i + 1]))))
  it('draws a ladder only inside its boxes', () => {
    const s = emptySnap()
    put(s, 5, 5, 5, packVoxel(LADDER_ID.ladder, ladderState(0)))
    const m = new Mesher().mesh(s, tables).opaque!
    expect(m.vertices.length).toBeGreaterThan(0)
    const boxes = shapeBoxes(SHAPE.LADDER, ladderState(0), STRAIGHT)
    for (let i = 0; i < m.vertices.length; i += 8) {
      const c = [0, 0, 0]
      for (let k = 0; k < 4; k++) {
        const a = unpackA(m.vertices[i + k * 2]!), b = unpackB(m.vertices[i + k * 2 + 1]!)
        c[0]! += (a.x * 16 + b.fx) / 4; c[1]! += (a.y * 16 + b.fy) / 4; c[2]! += (a.z * 16 + b.fz) / 4
      }
      const n = FACE_NORMALS[unpackA(m.vertices[i]!).normal]!
      const p = c.map((v, j) => v - 5 * 16 - n[j]! * 0.01)
      expect(boxes.some((b) => p[0]! >= b[0] && p[0]! <= b[3] && p[1]! >= b[1] && p[1]! <= b[4] && p[2]! >= b[2] && p[2]! <= b[5])).toBe(true)
    }
  })
  it('lights a torch on a post at 14', () => {
    const store = new ChunkStore({ buffers: createWorldBuffers([32, 32, 32]), opaque: reg.opaque })
    const light = new LightEngine(store, { opaque: reg.blocksLight, emits: reg.emits })
    for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) store.setVoxel(x, 20, z, ID.stone)
    store.setVoxel(10, 10, 10, LADDER_ID.torch_post)
    light.initialize()
    expect(blockLight(store.getLight(10, 10, 10))).toBe(14)
    expect(blockLight(store.getLight(11, 10, 10))).toBe(13)
  })
})
