import { parentPort, workerData } from 'node:worker_threads'
import { ChunkStore } from '../../src/world/chunkStore.ts'
import type { WorldBuffers } from '../../src/world/buffers.ts'

const { buffers, opaque, iterations } = workerData as { buffers: WorldBuffers; opaque: Uint8Array; iterations: number }
const store = new ChunkStore({ buffers, opaque, onNewPage: (index, page) => parentPort!.postMessage({ type: 'page', index, page }) })

// The writer reopens the chunk right after each commit, so without a pause a reader would
// never see it stable. Sleeping ~1 ms per commit gives snapshots a window to succeed mid-run.
const nap = new Int32Array(new SharedArrayBuffer(4))

// Voxel (0,0,0) is a fixed marker so the chunk never collapses to uniform.
store.setVoxel(0, 0, 0, 3)
store.commit()
parentPort!.once('message', () => {
  for (let k = 0; k < iterations; k++) {
    const v = 1 + (k % 2) // alternate stone/dirt across the other 32767 voxels
    for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) for (let x = 0; x < 32; x++) {
      if (x || y || z) store.setVoxel(x, y, z, v)
    }
    store.commit()
    Atomics.wait(nap, 0, 0, 1)
  }
  parentPort!.postMessage({ type: 'done' })
})
