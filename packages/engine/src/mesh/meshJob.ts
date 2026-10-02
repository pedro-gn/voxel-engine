import type { FromMesh, Override } from '../protocol.ts'
import type { WorldBuffers } from '../world/buffers.ts'
import { PAD, WorldReader, createSnapshot, padIndex, type ChunkSnapshot } from '../world/reader.ts'
import { voxelId } from '../world/voxel.ts'
import { Mesher, type ChunkMeshData } from './mesher.ts'
import type { MeshTables } from './tables.ts'

const EMPTY: ChunkMeshData = { opaque: null, cutout: null, translucent: null }
const OFFS = [1, -1, PAD * PAD, -PAD * PAD, PAD, -PAD] // +x -x +y -y +z -z in padded index space
const UP = 2

export class MeshJobRunner {
  private readonly reader: WorldReader
  private readonly tables: MeshTables
  private readonly snap: ChunkSnapshot = createSnapshot()
  private readonly mesher = new Mesher()

  constructor(buffers: WorldBuffers, tables: MeshTables) {
    this.reader = new WorldReader(buffers, tables.opaque)
    this.tables = tables
  }

  addPage(index: number, page: SharedArrayBuffer): void { this.reader.addPage(index, page) }

  /** Never throws on a failed snapshot: a `retry` result tells the main thread to requeue the job. */
  run(job: { id: number; chunk: number; overrides?: readonly Override[] }): FromMesh {
    const { id, chunk } = job
    const hasOverrides = job.overrides !== undefined && job.overrides.length > 0
    if (!hasOverrides) {
      // isTrivial reads the table without a seqlock bracket, so only trust it if the version
      // was even before and unchanged after; otherwise fall through to the validated snapshot.
      // The fence keeps isTrivial's plain table loads from completing after the validation load.
      const v0 = Atomics.load(this.reader.versions, chunk)
      if ((v0 & 1) === 0 && this.reader.isTrivial(chunk)) {
        this.reader.fence()
        if (Atomics.load(this.reader.versions, chunk) === v0) {
          return { type: 'result', id, chunk, version: v0, data: EMPTY }
        }
      }
    }
    const version = this.reader.snapshot(chunk, this.snap)
    if (version === null) return { type: 'retry', id, chunk }
    if (hasOverrides) this.applyOverrides(chunk, job.overrides!)
    return { type: 'result', id, chunk, version, data: this.mesher.mesh(this.snap, this.tables) }
  }

  private applyOverrides(chunk: number, overrides: readonly Override[]): void {
    const [cx, cy, cz] = this.reader.layout.chunkCoords(chunk)
    const s = this.snap
    for (const [x, y, z, v] of overrides) {
      const px = x - cx * 32 + 1, py = y - cy * 32 + 1, pz = z - cz * 32 + 1
      if (px < 0 || py < 0 || pz < 0 || px >= PAD || py >= PAD || pz >= PAD) continue
      const pi = padIndex(px, py, pz)
      s.voxels[pi] = v
      if (this.tables.opaque[voxelId(v)]) { s.light[pi] = 0; continue }
      // Approximate the light the sim will compute, so a freshly dug hole is not black for a tick.
      let sky = 0, blk = 0
      for (let d = 0; d < 6; d++) {
        const ni = pi + OFFS[d]!
        if (ni < 0 || ni >= s.light.length) continue
        const l = s.light[ni]!
        const ns = l & 15
        sky = Math.max(sky, d === UP && ns === 15 ? 15 : ns - 1)
        blk = Math.max(blk, (l >> 4) - 1)
      }
      s.light[pi] = Math.max(0, sky) | (Math.max(0, blk) << 4)
    }
  }
}
