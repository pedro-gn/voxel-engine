import type { FromMesh, Override } from '../protocol.ts'
import type { WorldBuffers } from '../world/buffers.ts'
import { PAD, WorldReader, createSnapshot, padIndex, type ChunkSnapshot } from '../world/reader.ts'
import { AIR, FULL_SKY, voxelId } from '../world/voxel.ts'
import { Mesher, type ChunkMeshData } from './mesher.ts'
import type { MeshTables } from './tables.ts'

const EMPTY: ChunkMeshData = { opaque: null, cutout: null, translucent: null, liquid: null, grass: null, flowers: null }
const OFFS = [1, -1, PAD * PAD, -PAD * PAD, PAD, -PAD] // +x -x +y -y +z -z in padded index space
const UP = 2

/**
 * The layer cut through one chunk (spec §4): `py` is the padded y of the cut layer; `covered[px + pz × PAD]` is what lay on
 * top of each cut-layer cell before the cut: 0 air, 1 an opaque block (its top face is created by the cut), 2 anything else.
 */
export interface CutPlane { py: number; covered: Uint8Array }

/** Reads every voxel above world y `cut` as air lit by the open sky, and records what covered each cut-layer cell. */
export function applyCut(s: ChunkSnapshot, oy: number, cut: number, opaque: Uint8Array): CutPlane {
  const py = cut - oy + 1
  const covered = new Uint8Array(PAD * PAD)
  for (let pz = 0; pz < PAD; pz++) for (let px = 0; px < PAD; px++) {
    const above = py + 1 < PAD ? s.voxels[padIndex(px, py + 1, pz)]! : AIR
    covered[px + pz * PAD] = above === AIR ? 0 : opaque[voxelId(above)] ? 1 : 2
    for (let y = Math.max(py + 1, 0); y < PAD; y++) { const i = padIndex(px, y, pz); s.voxels[i] = AIR; s.light[i] = FULL_SKY }
  }
  return { py, covered }
}

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
  run(job: { id: number; chunk: number; overrides?: readonly Override[]; cut?: number }): FromMesh {
    const { id, chunk } = job
    const hasOverrides = job.overrides !== undefined && job.overrides.length > 0
    // A cut opens even a uniform chunk: no trivial fast path under it.
    if (!hasOverrides && job.cut === undefined) {
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
    const [cx, cy, cz] = this.reader.layout.chunkCoords(chunk)
    const plane = job.cut !== undefined ? applyCut(this.snap, cy * 32, job.cut, this.tables.opaque) : undefined
    const data = this.mesher.mesh(this.snap, this.tables, cx * 32, cy * 32, cz * 32, plane)
    return { type: 'result', id, chunk, version, data, ...(job.cut !== undefined && { cut: job.cut }) }
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
