import { describe, expect, it } from 'vitest'
import { roofsSnap, shapedMeshTables, surfaceSnap, meshTables as benchTables } from '../bench/surface.ts'
import { Mesher, type ChunkMeshData } from '../src/mesh/mesher.ts'
import { applyCut, type CutPlane } from '../src/mesh/meshJob.ts'
import { padIndex, type ChunkSnapshot } from '../src/world/reader.ts'
import { packLight, packVoxel } from '../src/world/voxel.ts'
import { ID } from './helpers.ts'
import { emptySnap, meshTables, put } from './meshHelpers.ts'

/** FNV-1a (32-bit) over the bytes of every builder's vertices and indices, in a fixed order; null builders hash a marker. */
function hashMesh(m: ChunkMeshData): string {
  let h = 0x811c9dc5
  const byte = (b: number) => { h = Math.imul(h ^ (b & 255), 0x01000193) >>> 0 }
  const words = (a: Uint32Array) => {
    for (let i = 0; i < a.length; i++) { const w = a[i]!; byte(w); byte(w >>> 8); byte(w >>> 16); byte(w >>> 24) }
  }
  for (const k of ['opaque', 'cutout', 'translucent', 'liquid'] as const) {
    const l = m[k]
    if (l === null) { byte(0xee); continue }
    words(l.vertices); byte(0xaa); words(l.indices); byte(0xbb)
  }
  for (const k of ['grass', 'flowers'] as const) {
    const l = m[k]
    if (l === null) { byte(0xee); continue }
    words(l); byte(0xcc)
  }
  return h.toString(16).padStart(8, '0')
}

/** Leaves and torches (cutout, TEST_BLOCKS) beside and on stone, a crown of leaves with state bits set, glass and water. */
function leavesSnap(): ChunkSnapshot {
  const s = emptySnap()
  for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) put(s, x, 3, z, ID.stone)
  for (let x = 4; x < 11; x++) for (let y = 6; y < 11; y++) for (let z = 4; z < 11; z++) {
    if ((x - 7) ** 2 + (y - 8) ** 2 + (z - 7) ** 2 <= 10) put(s, x, y, z, packVoxel(ID.leaves, (x + y + z) & 3))
  }
  for (let y = 4; y < 7; y++) put(s, 7, y, 7, ID.stone)
  for (const [x, z] of [[20, 20], [21, 20], [20, 21], [0, 0], [31, 31]] as const) put(s, x, 4, z, ID.leaves)
  put(s, 22, 4, 22, ID.torch); put(s, 23, 4, 22, ID.stone); put(s, 22, 5, 22, ID.torch)
  put(s, 31, 4, 10, ID.leaves); put(s, 32, 4, 10, ID.leaves) // a leaf across the chunk border, in the apron
  put(s, -1, 4, 12, ID.leaves); put(s, 0, 4, 12, ID.leaves)
  put(s, 15, 4, 15, ID.glass); put(s, 16, 4, 15, ID.water)
  for (let x = 0; x < 34; x++) for (let z = 0; z < 34; z++) for (let y = 0; y < 6; y++) s.light[padIndex(x, y, z)] = packLight(y < 5 ? 0 : 12, y === 5 ? 3 : 0)
  return s
}

const mesher = new Mesher()
const hashOf = (snap: ChunkSnapshot, tables: ReturnType<typeof meshTables>, plane?: CutPlane) => hashMesh(mesher.mesh(snap, tables, 32, 0, 64, plane))

describe('mesh golden', () => {
  // Recorded on engine main b9224fc, before the tone and fringe options existed: worlds that use neither must mesh to
  // the same bytes.
  it('mesh bytes are unchanged without tone/fringe', () => {
    const cut = leavesSnap(), t = meshTables()
    expect({
      surface: hashOf(surfaceSnap(), benchTables()),
      roofs: hashOf(roofsSnap(), shapedMeshTables()),
      leaves: hashOf(leavesSnap(), meshTables()),
      leavesCut: hashOf(cut, t, applyCut(cut, 0, 8, t.blocksLight)),
    }).toEqual({ surface: 'ff5c4d6c', roofs: 'd625f280', leaves: '43d4e069', leavesCut: '11e70b1d' })
  })
})
