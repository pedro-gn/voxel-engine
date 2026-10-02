import type { Layout } from '../world/layout.ts'
import { voxelId } from '../world/voxel.ts'

export type Vec3 = readonly [number, number, number]
export interface SetBlockCommand { type: 'setBlock'; pos: Vec3; voxel: number }
export interface FillRegionCommand { type: 'fillRegion'; min: Vec3; max: Vec3; voxel: number }
export interface CustomCommand { type: string; [key: string]: unknown }
export type Command = SetBlockCommand | FillRegionCommand | CustomCommand

export interface StampedCommand { tick: number; clientId: number; seq: number; cmd: Command }
export interface Ack { clientId: number; seq: number; ok: boolean; error?: string }

export const MAX_FILL_VOXELS = 1 << 20

function checkPos(name: string, p: unknown, layout: Layout): string | null {
  if (!Array.isArray(p) || p.length !== 3) return `${name}: pos must be [x, y, z]`
  const [x, y, z] = p as number[]
  if (!layout.inBounds(x!, y!, z!)) return `${name}: position [${p.join(', ')}] is out of bounds`
  return null
}

function checkVoxel(v: unknown, blockCount: number): string | null {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 0xffff) return `invalid voxel ${String(v)}`
  if (voxelId(v) >= blockCount) return `unknown block id ${voxelId(v)}`
  return null
}

export function validateCommand(cmd: Command, layout: Layout, blockCount: number, customTypes: ReadonlySet<string>): string | null {
  if (cmd.type === 'setBlock') {
    const c = cmd as SetBlockCommand
    return checkPos('setBlock', c.pos, layout) ?? checkVoxel(c.voxel, blockCount)
  }
  if (cmd.type === 'fillRegion') {
    const c = cmd as FillRegionCommand
    const err = checkPos('fillRegion min', c.min, layout) ?? checkPos('fillRegion max', c.max, layout) ?? checkVoxel(c.voxel, blockCount)
    if (err) return err
    let volume = 1
    for (let a = 0; a < 3; a++) {
      if (c.min[a]! > c.max[a]!) return 'fillRegion: min must be <= max on every axis'
      volume *= c.max[a]! - c.min[a]! + 1
    }
    if (volume > MAX_FILL_VOXELS) return `fillRegion too large: ${volume} voxels (max ${MAX_FILL_VOXELS})`
    return null
  }
  if (typeof cmd.type !== 'string' || !customTypes.has(cmd.type)) return `unknown command type "${String(cmd.type)}"`
  return null
}

export function compareStamped(a: StampedCommand, b: StampedCommand): number {
  return a.tick - b.tick || a.clientId - b.clientId || a.seq - b.seq
}
