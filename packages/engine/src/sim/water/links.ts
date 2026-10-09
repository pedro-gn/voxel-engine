/** A link to dry ground: LINK_GROUND | its height (blocks). */
export const LINK_GROUND = 0x8000
/** No segment of the neighbour overlaps, or the one met is ranked past the draw layers: a wall. */
export const LINK_WALL = 0x7fff
/** Ints per record of WaterTick.layers (plan design notes: Publishing). */
export const RECORD = 6
/** Sides in link order: +x, −x, +z, −z (render/water/surfaceMesh.ts DIR_X / DIR_Z). */
export const SIDE_X: readonly number[] = [1, -1, 0, 0]
export const SIDE_Z: readonly number[] = [0, 0, 1, -1]
