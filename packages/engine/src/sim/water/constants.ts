import { SUB } from '../../world/waterBuffers.ts'

export { SUB }
/** Flux carries FLUX_FP extra bits: a stored flux of 16 moves 1/SUB block per step. */
export const FLUX_FP = 4
/** Friction: every step a flux loses 1/2^FRICTION_SHIFT of itself, at least one stored unit (rounded away from zero). */
export const FRICTION_SHIFT = 4
/**
 * Stored flux gained per step per 1/SUB block of head: k = GAIN / 2^FLUX_FP = 3/16. The step is symplectic Euler on the
 * discrete wave equation; its stiffest (checkerboard) mode is stable while 8k ≤ 4, so k = 3/16 keeps a 2.7× margin.
 */
export const GAIN = 3
/**
 * The gain of a step in which the tile cap leaves awake tiles out (k = 2/16). A throttled tile border is advanced out of
 * phase (each tile reads its neighbour's heads only when it steps), which lowers the stable gain far below the checkerboard
 * bound: measured on a 32 × 32 box at cap 1, k up to about 2.2/16 damps and k from 2.25/16 up locks into a z-checkerboard
 * limit cycle on the border columns that never sleeps. 2/16 is under that, with a thin margin (about 10%), and the
 * throttled water is slow anyway: each tile advances 1/N of the steps. An unthrottled step uses GAIN.
 */
export const THROTTLED_GAIN = 2
/** The head an edge feels is clamped to 2 blocks: a cliff does not accelerate water without bound, the excess just pours. */
export const MAX_HEAD = 2 * SUB
/** A column shallower than this (1/64 block) sends nothing: films stay as damp puddles. */
export const MIN_FLOW = 4
/** Columns per tile side. */
export const TILE = 16
/** Quiet steps before a tile falls asleep (half a second at 20 Hz). */
export const SLEEP_STEPS = 10
/** A tile is quiet while every edge it moved carried less than this (1/SUB block per step)… */
export const FLUX_EPS = 3
/**
 * …and no column of it changed by more than this since its last step: 4 × (FLUX_EPS − 1), the most a quiet column can
 * change (four edges each moving 1/SUB). A still lake's integer heads keep 1/SUB moves going forever; below this they never sleep.
 */
export const DEPTH_EPS = 4 * (FLUX_EPS - 1)
/**
 * …and no run of connected water along a row or column of it (its borders included) spans more than this (1/SUB block).
 * A still lake never comes to rest in integers: a leftover 1/SUB bump moves on, leaving a −3/+1 pattern behind, so runs
 * span up to 4–5 while the lake is flat (at 3 lakes never sleep, at 4 they take far longer). 6 sleeps above that jiggle and
 * stays far under the mirror's quantum (SUB / 8).
 */
export const HEAD_EPS = 6
/**
 * …and the tile's mean slope along x and along z stays at or under 1/2^SLOPE_SHIFT sub-unit per column, with 1/SUB of slack
 * in all. Each run of 8 columns or more gives its fall from the mean of 4 surfaces at each end, so leftover bumps cancel
 * while a slope adds up. With zero flux, heads of 1–2 sub take longer than SLEEP_STEPS to move anything: without this test
 * a gentle slope would fall asleep as it is. At 1/16 a 256-column channel ends within one mirror level (measured 25–29).
 */
export const SLOPE_SHIFT = 4
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
