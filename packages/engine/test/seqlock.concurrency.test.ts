import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import { createWorldBuffers } from '../src/world/buffers.ts'
import { WorldReader, createSnapshot, padIndex } from '../src/world/reader.ts'
import { testRegistry } from './helpers.ts'

describe('seqlock across threads', () => {
  it('never returns a torn chunk', async () => {
    const reg = testRegistry()
    const buffers = createWorldBuffers([64, 64, 64])
    const reader = new WorldReader(buffers, reg.opaque)
    const worker = new Worker(new URL('./fixtures/seqlockWriter.ts', import.meta.url), {
      workerData: { buffers, opaque: reg.opaque, iterations: 150 },
    })
    let done = false
    await new Promise<void>((resolve, reject) => {
      worker.on('error', reject)
      worker.on('message', (m: { type: string; index?: number; page?: SharedArrayBuffer }) => {
        if (m.type === 'page') { reader.addPage(m.index!, m.page!); worker.postMessage('start'); resolve() }
        if (m.type === 'done') done = true
      })
    })
    const snap = createSnapshot()
    const seen = new Set<number>() // fully-written states observed in successful snapshots
    let good = 0
    let torn = 0
    while (!done) {
      for (let i = 0; i < 50; i++) {
        const version = reader.snapshot(0, snap)
        if (version === null) continue
        const first = snap.voxels[padIndex(2, 1, 1)]! // voxel (1,0,0)
        let same = true
        for (let y = 0; y < 32 && same; y++) for (let z = 0; z < 32 && same; z++) for (let x = 0; x < 32; x++) {
          if (!(x || y || z)) continue
          if (snap.voxels[padIndex(x + 1, y + 1, z + 1)] !== first) { same = false; break }
        }
        // Writer versions: marker commit -> 2 (only voxel 0 set, rest air); iteration k commits version 4 + 2k with value 1 + (k % 2).
        const expected = version >= 4 ? 1 + (((version - 4) / 2) % 2) : 0
        if (same && version % 2 === 0 && first === expected) { good++; seen.add(first) }
        else torn++
      }
      await new Promise((r) => setImmediate(r))
    }
    await worker.terminate()
    expect(torn).toBe(0)
    expect(good).toBeGreaterThan(0)
    // The writer alternates 1, 2, ... (150 iterations, so it ends on 2), so seeing both proves we snapshotted mid-run.
    expect(seen.has(1)).toBe(true)
    expect(seen.has(2)).toBe(true)
  }, 30_000)
})
