import type { ChunkSnapshot } from '../world/reader.ts'
import { meshOpaqueAndCutout } from './greedy.ts'
import { meshTranslucent } from './liquid.ts'
import { QuadBuilder, type LayerMesh } from './quadBuilder.ts'
import type { MeshTables } from './tables.ts'

export interface ChunkMeshData {
  opaque: LayerMesh | null
  cutout: LayerMesh | null
  translucent: LayerMesh | null
  liquid: LayerMesh | null
}

export class Mesher {
  private readonly opaque = new QuadBuilder(2048)
  private readonly cutout = new QuadBuilder(256)
  private readonly translucent = new QuadBuilder(512)
  private readonly liquid = new QuadBuilder(512)
  private readonly mask = new Int32Array(1024)

  mesh(snap: ChunkSnapshot, tables: MeshTables): ChunkMeshData {
    this.opaque.reset()
    this.cutout.reset()
    this.translucent.reset()
    this.liquid.reset()
    meshOpaqueAndCutout(snap, tables, this.opaque, this.cutout, this.mask)
    meshTranslucent(snap, tables, this.translucent, this.liquid)
    return { opaque: this.opaque.build(), cutout: this.cutout.build(), translucent: this.translucent.build(), liquid: this.liquid.build() }
  }
}

const shared = new Mesher()

/** Meshes all four layers of a snapshot using a shared, buffer-reusing Mesher. */
export function meshChunk(snap: ChunkSnapshot, tables: MeshTables): ChunkMeshData {
  return shared.mesh(snap, tables)
}
