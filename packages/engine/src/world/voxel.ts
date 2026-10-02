export const AIR = 0
export const MAX_BLOCK_ID = 4095
const ID_MASK = 0x0fff

export function packVoxel(id: number, state = 0): number {
  if (!Number.isInteger(id) || id < 0 || id > MAX_BLOCK_ID) throw new RangeError(`block id out of range: ${id}`)
  if (!Number.isInteger(state) || state < 0 || state > 15) throw new RangeError(`block state out of range: ${state}`)
  return (state << 12) | id
}
export function voxelId(v: number): number { return v & ID_MASK }
export function voxelState(v: number): number { return (v >>> 12) & 0xf }
export function withState(v: number, s: number): number { return (v & ID_MASK) | ((s & 0xf) << 12) }

export function packLight(sky: number, block: number): number { return (sky & 0xf) | ((block & 0xf) << 4) }
export function skyLight(l: number): number { return l & 0xf }
export function blockLight(l: number): number { return (l >>> 4) & 0xf }
export const FULL_SKY = 15
