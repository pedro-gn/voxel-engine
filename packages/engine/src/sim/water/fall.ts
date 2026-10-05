import { SUB } from './constants.ts'

/**
 * Waterfalls are ballistic: water pouring over an edge where the surface drops more than FALL_MIN leaves level at the exit
 * speed v = exitSpeed(flux) and falls under ARC_GRAVITY, landing v · √(2 drop / g) in front of its wall. The step delivers
 * it there (WaterColumns: a fall's water skips the columns it flies over) and the renderer draws its curtain along the same
 * arc (render/water/surfaceMesh.ts), so the sheet lands where the water does. The exit speed compresses the flow (its
 * square root), calibrated on the flood scene's measured curtains (flux in 1/SUB block per step at 20 steps per second;
 * reach over flat ground):
 *
 * | flow                         | flux | drop (blocks) | reach (blocks) |
 * |------------------------------|------|---------------|----------------|
 * | a trickle                    |    8 |             4 |           0.22 |
 * | one removed dam block        |  110 |            15 |           1.61 |
 * | the 10-wide breach           |  210 |            14 |           2.14 |
 * | a dam column (the most seen) |  480 |            12 |           3.00 |
 *
 * so a small flow trickles close to its wall, a big one arcs out, and ARC_REACH is only a guard.
 */
export const ARC_GRAVITY = 20
/** The farthest (blocks) a fall lands from its wall: a guard, so the arc never reaches into geometry farther away. */
export const ARC_REACH = 3
/** The least distance (blocks) a curtain hangs in front of its wall's plane below its top, even with no flow. */
export const ARC_GAP = 1 / 16
/** The discharge (blocks² per second through a one-block edge) that leaves at 1 block/s (see exitSpeed). */
const EXIT_DISCHARGE = 5
/** A drop (1/SUB block) larger than this from a sender's surface to the level of the column it sends to is a fall: the renderer hangs a curtain there (JOIN). */
export const FALL_MIN = SUB
/** Steps per second the water steps at (the tick rate): the exit speed of the water a step moves. */
export const FALL_HZ = 20

/**
 * Exit speed (blocks/s) of the water pouring over an edge that moves `flux` (1/SUB block per step through its one-block
 * width) at `stepHz` steps per second: √(q / EXIT_DISCHARGE) with q = flux · stepHz / SUB the discharge, i.e. 0.125 · √flux
 * at 20 steps per second (see ARC_GRAVITY for the calibration). The upper column's depth is no help: the outflow limiter
 * drains a brink column every step, so flux / depth sits at one column per step whatever the flow.
 */
export function exitSpeed(flux: number, stepHz: number): number {
  return Math.sqrt((Math.max(0, flux) * stepHz) / SUB / EXIT_DISCHARGE)
}

/**
 * The column (0 the one past the edge, at most `clear`) where the water a fall moves in a step lands: `moved` (1/SUB block) over
 * a drop of `drop` (1/SUB block) lands ARC_GAP + v · √(2 drop / ARC_GRAVITY) in front of the wall, at most ARC_REACH out.
 */
export function fallColumn(moved: number, drop: number, clear: number): number {
  const reach = Math.min(ARC_REACH, exitSpeed(moved, FALL_HZ) * Math.sqrt((2 * drop) / SUB / ARC_GRAVITY))
  return Math.min(clear, Math.floor(ARC_GAP + reach))
}
