// Vitest-free mesh fixtures, shared by tests and the plain-Node benchmark.
import { meshTablesFrom, type MeshTables } from '../src/mesh/tables.ts'
import { createSnapshot, type ChunkSnapshot } from '../src/world/reader.ts'
import { AIR, FULL_SKY } from '../src/world/voxel.ts'
import { testRegistry } from './helpers.ts'

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
