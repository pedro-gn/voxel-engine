// Vitest-free mesh fixtures, shared by tests and the plain-Node benchmark.
import { meshTablesFrom, type MeshTables } from '../src/mesh/tables.ts'
import { createSnapshot, type ChunkSnapshot } from '../src/world/reader.ts'
import { AIR, FULL_SKY } from '../src/world/voxel.ts'
import { BlockRegistry } from '../src/blocks/registry.ts'
import { DecorationRegistry, defineDecoration } from '../src/render/decorations/defs.ts'
import { TEST_BLOCKS, testRegistry } from './helpers.ts'

export function emptySnap(): ChunkSnapshot {
  const s = createSnapshot()
  s.voxels.fill(AIR)
  s.light.fill(FULL_SKY)
  return s
}

export function meshTables(): MeshTables {
  const reg = testRegistry()
  return meshTablesFrom(reg, reg.faceLayers(new Map(reg.textureNames().map((n, i) => [n, i + 1]))))
}

export const MEADOW = defineDecoration({ name: 'meadow', grass: {}, flowers: { chance: 1, patchScale: 12 } })

/** Test registry with grass decorated by MEADOW (same block ids as testRegistry()). */
export function decoratedMeshTables(decorations = [MEADOW]): MeshTables {
  const reg = new BlockRegistry(TEST_BLOCKS.map((b) => (b.name === 'grass' ? { ...b, decoration: decorations[0]!.name } : b)))
  const deco = new DecorationRegistry(decorations, reg)
  return meshTablesFrom(reg, reg.faceLayers(new Map(reg.textureNames().map((n, i) => [n, i + 1]))), deco.tables)
}
