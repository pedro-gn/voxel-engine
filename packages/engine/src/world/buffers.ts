import { CHUNK_VOLUME, Layout, type WorldSize } from './layout.ts'
import { FULL_SKY, voxelId } from './voxel.ts'

export const SLOTS_PER_PAGE = 256
export const SLOT_VOXEL_BYTES = CHUNK_VOLUME * 2
export const SLOT_BYTES = SLOT_VOXEL_BYTES + CHUNK_VOLUME
export const PAGE_BYTES = SLOTS_PER_PAGE * SLOT_BYTES

export interface WorldBuffers {
  size: WorldSize
  chunkTable: SharedArrayBuffer
  versions: SharedArrayBuffer
}

export function encodeUniform(voxel: number): number { return -(voxel + 1) }
export function decodeUniform(entry: number): number { return -entry - 1 }

export function impliedLight(voxel: number, opaque: Uint8Array): number {
  return opaque[voxelId(voxel)] ? 0 : FULL_SKY
}

export function createWorldBuffers(size: WorldSize): WorldBuffers {
  const layout = new Layout(size)
  const chunkTable = new SharedArrayBuffer(layout.chunkCount * 4)
  new Int32Array(chunkTable).fill(encodeUniform(0))
  return { size: layout.size, chunkTable, versions: new SharedArrayBuffer(layout.chunkCount * 4) }
}

export class SlotViews {
  readonly pages: SharedArrayBuffer[] = []
  private readonly voxelViews: Uint16Array[] = []
  private readonly lightViews: Uint8Array[] = []

  get pageCount(): number { return this.pages.length }

  addPage(index: number, page: SharedArrayBuffer): void {
    if (this.pages[index]) return
    this.pages[index] = page
    for (let s = 0; s < SLOTS_PER_PAGE; s++) {
      const off = s * SLOT_BYTES
      this.voxelViews[index * SLOTS_PER_PAGE + s] = new Uint16Array(page, off, CHUNK_VOLUME)
      this.lightViews[index * SLOTS_PER_PAGE + s] = new Uint8Array(page, off + SLOT_VOXEL_BYTES, CHUNK_VOLUME)
    }
  }
  hasSlot(slot: number): boolean { return this.voxelViews[slot] !== undefined }
  voxels(slot: number): Uint16Array { return this.voxelViews[slot]! }
  light(slot: number): Uint8Array { return this.lightViews[slot]! }
}
