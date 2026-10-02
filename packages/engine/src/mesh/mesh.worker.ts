import type { FromMesh, ToMesh } from '../protocol.ts'
import { MeshJobRunner } from './meshJob.ts'
import type { ChunkMeshData } from './mesher.ts'

interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((e: MessageEvent<ToMesh>) => void) | null
}
const scope = globalThis as unknown as WorkerScope
let runner: MeshJobRunner | null = null

function transferables(d: ChunkMeshData): Transferable[] {
  const out: Transferable[] = []
  for (const m of [d.opaque, d.cutout, d.translucent, d.liquid]) if (m) out.push(m.vertices.buffer, m.indices.buffer)
  for (const a of [d.grass, d.flowers]) if (a) out.push(a.buffer)
  return out
}

scope.onmessage = (e) => {
  const m = e.data
  if (m.type === 'init') {
    runner = new MeshJobRunner(m.buffers, m.tables)
    m.pages.forEach((p, i) => runner!.addPage(i, p))
    return
  }
  if (m.type === 'page') { runner?.addPage(m.index, m.page); return }
  let out: FromMesh
  try {
    out = runner!.run(m)
  } catch (err) {
    out = { type: 'error', id: m.id, chunk: m.chunk, message: err instanceof Error ? (err.stack ?? err.message) : String(err) }
  }
  scope.postMessage(out, out.type === 'result' ? transferables(out.data) : [])
}
