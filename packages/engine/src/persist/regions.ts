import { decodeUniform } from '../world/buffers.ts'
import type { ChunkStore } from '../world/chunkStore.ts'
import { CHUNK_VOLUME, type Layout } from '../world/layout.ts'

/** A save region is REGION_CHUNKS × REGION_CHUNKS chunk columns (256 × 256 blocks), full height; edge regions are clipped. */
export const REGION_CHUNKS = 8
export const REGION_FORMAT = 1
const MAGIC = 0x47525645 // 'EVRG'

export function regionGrid(L: Layout): { rx: number; rz: number; count: number } {
  const rx = Math.ceil(L.cx / REGION_CHUNKS), rz = Math.ceil(L.cz / REGION_CHUNKS)
  return { rx, rz, count: rx * rz }
}

export function regionOfChunk(L: Layout, ci: number): number {
  const [cx, , cz] = L.chunkCoords(ci)
  return Math.floor(cx / REGION_CHUNKS) + Math.floor(cz / REGION_CHUNKS) * regionGrid(L).rx
}

/** Region r's chunks in a fixed order: cy, then cz, then cx. */
function regionChunks(L: Layout, r: number): number[] {
  const { rx } = regionGrid(L), x0 = (r % rx) * REGION_CHUNKS, z0 = Math.floor(r / rx) * REGION_CHUNKS
  const out: number[] = []
  for (let cy = 0; cy < L.cy; cy++) for (let cz = z0; cz < Math.min(L.cz, z0 + REGION_CHUNKS); cz++) for (let cx = x0; cx < Math.min(L.cx, x0 + REGION_CHUNKS); cx++) out.push(L.chunkIndex(cx, cy, cz))
  return out
}

/**
 * [magic u32][format u16][chunks u16] then per chunk: kind u8 (0 uniform, 1 dense) and a u16 voxel or 32³ u16 voxels.
 * The blob does not name its region (the manifest does), so equal regions share a blob. Light is not stored.
 */
export function encodeRegion(store: ChunkStore, r: number): Uint8Array {
  const chunks = regionChunks(store.layout, r)
  let size = 8
  for (const ci of chunks) size += store.table[ci]! < 0 ? 3 : 1 + CHUNK_VOLUME * 2
  const out = new Uint8Array(size), dv = new DataView(out.buffer)
  dv.setUint32(0, MAGIC, true); dv.setUint16(4, REGION_FORMAT, true); dv.setUint16(6, chunks.length, true)
  let at = 8
  for (const ci of chunks) {
    const e = store.table[ci]!
    if (e < 0) { out[at] = 0; dv.setUint16(at + 1, decodeUniform(e), true); at += 3; continue }
    out[at++] = 1
    const v = store.views.voxels(e)
    out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), at) // host byte order: little endian everywhere we run
    at += CHUNK_VOLUME * 2
  }
  return out
}

/** Calls `put` for every chunk of region r: a number for a uniform chunk, else its voxels (a fresh array). */
export function decodeRegion(bytes: Uint8Array, L: Layout, r: number, put: (ci: number, data: Uint16Array | number) => void): void {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 8 || dv.getUint32(0, true) !== MAGIC) throw new Error('not a save region')
  const format = dv.getUint16(4, true)
  if (format !== REGION_FORMAT) throw new Error(`region format ${format}, engine expects ${REGION_FORMAT}`)
  const chunks = regionChunks(L, r)
  if (dv.getUint16(6, true) !== chunks.length) throw new Error(`region ${r} holds ${dv.getUint16(6, true)} chunks, the world expects ${chunks.length}`)
  let at = 8
  for (const ci of chunks) {
    if (bytes[at] === 0) { put(ci, dv.getUint16(at + 1, true)); at += 3; continue }
    const copy = bytes.slice(at + 1, at + 1 + CHUNK_VOLUME * 2)
    put(ci, new Uint16Array(copy.buffer))
    at += 1 + CHUNK_VOLUME * 2
  }
}
