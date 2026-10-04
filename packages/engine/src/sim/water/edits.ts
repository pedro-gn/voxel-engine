import { KIND, SUB, UNIT } from './constants.ts'

/** A column's floor and depth, changed in place by applyEdit. */
export interface EditColumn { floor: number; depth: number }

/** The column's voxels after the write: a cell's KIND, and its water units (1–8; 0 when it is not water); the world height. */
export interface ColumnCells { readonly height: number; kind(y: number): number; units(y: number): number }

/**
 * One voxel write at height y of a column (spec §4 Edits; plan decision 3, design notes: Edits). `oldKind` describes the voxel
 * before, `newKind`/`newUnits` after. Volume is exact:
 * - a wall in the water keeps the water and pushes it up;
 * - water a command removes or places changes the depth by exactly the cell's share of the column or the new units;
 * - static water a dug-out floor uncovers joins the column.
 * The old voxel's units are not needed: the column's own depth says how much a removed cell held.
 */
export function applyEdit(col: EditColumn, y: number, oldKind: number, newKind: number, newUnits: number, cells: ColumnCells): void {
  const f0 = col.floor
  const s0 = f0 * SUB + col.depth
  // Water overwritten by anything but a wall leaves the column; a wall over water displaces it instead.
  if (oldKind === KIND.WATER && newKind !== KIND.WALL && y >= f0) {
    col.depth = Math.max(0, col.depth - Math.min(SUB, Math.max(0, s0 - y * SUB)))
  }
  if (newKind === KIND.WALL && oldKind !== KIND.WALL) {
    // On the floor or in the water: the floor rises and the depth stays, so the surface rises by the displaced volume.
    if (y >= f0 && (y * SUB < s0 || y === f0)) {
      col.floor = y + 1
      // A wall run the new floor now touches (a floating block, a bridge in the water) rests on it: the floor is its top, as
      // rebuild finds it. Otherwise the water would start inside that run and leak through it.
      while (col.floor < cells.height && cells.kind(col.floor) === KIND.WALL) col.floor++
    }
  } else if (oldKind === KIND.WALL && newKind !== KIND.WALL && y === f0 - 1) {
    // The floor block dug out: the floor falls to the next wall below, and static water on the way joins the column.
    let f = y
    while (f > 0) {
      const k = cells.kind(f - 1)
      if (k === KIND.WALL) break
      if (k === KIND.WATER) col.depth += cells.units(f - 1) * UNIT
      f--
    }
    col.floor = f
  }
  if (newKind === KIND.WATER && y >= col.floor) col.depth += newUnits * UNIT
}
