import { InstanceBuilder, extractDecorations } from '../render/decorations/extract.ts'
import type { ChunkSnapshot } from '../world/reader.ts'
import { meshFringe } from './fringe.ts'
import { meshOpaqueAndCutout } from './greedy.ts'
import type { CutPlane } from './meshJob.ts'
import { meshTranslucent } from './liquid.ts'
import { QuadBuilder, type LayerMesh } from './quadBuilder.ts'
import { meshShapes } from './shapes.ts'
import type { MeshTables } from './tables.ts'

export interface ChunkMeshData {
  opaque: LayerMesh | null
  cutout: LayerMesh | null
  translucent: LayerMesh | null
  liquid: LayerMesh | null
  grass: Uint32Array | null
  flowers: Uint32Array | null
}

export class Mesher {
  private readonly opaque = new QuadBuilder(2048)
  private readonly cutout = new QuadBuilder(256)
  private readonly translucent = new QuadBuilder(512)
  private readonly liquid = new QuadBuilder(512)
  private readonly grass = new InstanceBuilder(1024)
  private readonly flowers = new InstanceBuilder(64)
  private readonly mask = new Int32Array(1024)

  /** `plane`: the layer cut through this chunk (meshJob.ts applyCut), if it crosses it. */
  mesh(snap: ChunkSnapshot, tables: MeshTables, ox = 0, oy = 0, oz = 0, plane?: CutPlane): ChunkMeshData {
    this.opaque.reset()
    this.cutout.reset()
    this.translucent.reset()
    this.liquid.reset()
    this.grass.reset()
    this.flowers.reset()
    // The fringe pass runs only when the cutout pass drew a face of a fringe block (none in most chunks).
    if (meshOpaqueAndCutout(snap, tables, this.opaque, this.cutout, this.mask, plane, ox, oy, oz)) meshFringe(snap, tables, this.cutout, plane, ox, oy, oz)
    meshShapes(snap, tables, this.opaque)
    meshTranslucent(snap, tables, this.translucent, this.liquid)
    extractDecorations(snap, tables, ox, oy, oz, this.grass, this.flowers, plane)
    return {
      opaque: this.opaque.build(), cutout: this.cutout.build(), translucent: this.translucent.build(), liquid: this.liquid.build(),
      grass: this.grass.build(), flowers: this.flowers.build(),
    }
  }
}

const shared = new Mesher()

/** Meshes all four layers of a snapshot using a shared, buffer-reusing Mesher. */
export function meshChunk(snap: ChunkSnapshot, tables: MeshTables, ox = 0, oy = 0, oz = 0): ChunkMeshData {
  return shared.mesh(snap, tables, ox, oy, oz)
}
