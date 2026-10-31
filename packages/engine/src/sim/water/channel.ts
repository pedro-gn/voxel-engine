import { FLUX_FP, FRICTION_SHIFT, GAIN, SPRING_RATES, SPRING_SCALE } from './constants.ts'

/**
 * Open-channel maths for generators that lay out rivers at rest (world-gen river diagnosis R1). Flow here is driven by the
 * surface's slope alone: an edge whose surfaces differ by h (1/SUB block) settles where friction takes back what the head
 * adds, ceil(f / 2^FRICTION_SHIFT) = GAIN·h, so it moves f >> FLUX_FP = GAIN·2^(FRICTION_SHIFT − FLUX_FP)·h − 1 per step
 * (the stored flux converges from below and is truncated).
 */

/** Water (1/SUB block per step) a spring of flow index `flow` (its voxel state) adds while nothing caps it. */
export function springRate(flow: number): number {
  return SPRING_RATES[flow & 15]! * SPRING_SCALE
}

/**
 * The steady surface fall (1/SUB block per column, fractional) that carries `q` (1/SUB block per step) along one lane of
 * open water: the inverse of q = GAIN·2^(FRICTION_SHIFT − FLUX_FP)·h − 1. A channel `lanes` wide carries q·lanes; a bed
 * flatter than this backs the water up, a steeper one thins it to a film.
 */
export function channelFall(q: number): number {
  return ((q + 1) * (1 << FLUX_FP)) / (GAIN * (1 << FRICTION_SHIFT))
}
