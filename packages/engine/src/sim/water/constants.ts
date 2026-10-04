import { SUB } from '../../world/waterBuffers.ts'

export { SUB }
/** Flux carries FLUX_FP extra bits: a stored flux of 16 moves 1/SUB block per step. */
export const FLUX_FP = 4
/** Friction: every step a flux loses 1/2^FRICTION_SHIFT of itself, at least one stored unit (rounded away from zero). */
export const FRICTION_SHIFT = 4
/**
 * Stored flux gained per step per 1/SUB block of head: k = GAIN / 2^FLUX_FP = 1/8. The step is symplectic Euler on the
 * discrete wave equation; its stiffest (checkerboard) mode is stable while 8k ≤ 4, so k = 1/8 keeps a 4× margin.
 */
export const GAIN = 2
/** The head an edge feels is clamped to 2 blocks: a cliff does not accelerate water without bound, the excess just pours. */
export const MAX_HEAD = 2 * SUB
/** A column shallower than this (1/64 block) sends nothing: films stay as damp puddles. */
export const MIN_FLOW = 4
/** Columns per tile side. */
export const TILE = 16
/** Quiet steps before a tile falls asleep (half a second at 20 Hz). */
export const SLEEP_STEPS = 10
/** A tile is quiet while every edge it moved carried less than this (1/SUB block per step)… */
export const FLUX_EPS = 2
/**
 * …and no column of it changed by more than this since its last step: 4 × (FLUX_EPS − 1), the most a quiet column can
 * change (four edges each moving 1/SUB). A still lake's integer heads keep 1/SUB moves going forever; below this they never sleep.
 */
export const DEPTH_EPS = 4
/** At rebuild, a wall run at most this thick that floats over air or water (a bridge, a canopy) hides no water below it. */
export const OVERHANG = 6
/** One liquid unit (1/8 block, a voxel level step) in 1/SUB block. */
export const UNIT = SUB / 8
/** A spring's flow per step, per its state (flow index): 3a's units per 10 Hz fluid step, × SPRING_SCALE. */
export const SPRING_RATES: readonly number[] = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 40, 48, 56, 64, 96, 128]
/** 3a units (32 sub) per 10 Hz step → sub per 20 Hz step: × 32 / 2. */
export const SPRING_SCALE = 16
/** What a voxel is to water. */
export const KIND = { AIR: 0, WATER: 1, WALL: 2 } as const
