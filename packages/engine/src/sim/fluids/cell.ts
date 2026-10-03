import type { BlockRegistry } from '../../blocks/registry.ts'
import { AIR, voxelId, voxelState } from '../../world/voxel.ts'

/** Units in a full liquid cell. A liquid cell holds level + 1 units; level 0–7 sits in state bits 0–2. */
export const FULL = 8

/** Units a spring injects per fluid step, indexed by the spring's state (its flow index). */
export const SPRING_RATES: readonly number[] = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 40, 48, 56, 64, 96, 128]

/** The group (base liquid id) of a flowing liquid voxel; 0 for air, solids and springs. */
export function flowGroup(reg: BlockRegistry, v: number): number {
  const id = voxelId(v)
  return reg.liquid[id] === 1 && reg.source[id] === 0 ? reg.liquidGroup[id]! : 0
}

export function isSource(reg: BlockRegistry, v: number): boolean {
  return reg.source[voxelId(v)] === 1
}

/** Units of liquid in a voxel: level + 1 for a liquid, FULL for a spring, 0 for anything else. */
export function volumeOf(reg: BlockRegistry, v: number): number {
  const id = voxelId(v)
  if (reg.liquid[id] !== 1) return 0
  return reg.source[id] === 1 ? FULL : (voxelState(v) & 7) + 1
}

/** The voxel holding `units` (1–8) of liquid `group`; air for 0. */
export function liquidVoxel(group: number, units: number): number {
  if (units <= 0) return AIR
  if (units > FULL || !Number.isInteger(units)) throw new RangeError(`a liquid cell holds 1–${FULL} units, got ${units}`)
  return ((units - 1) << 12) | group
}
