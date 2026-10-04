import { describe, expect, it } from 'vitest'
import { KIND, SUB, UNIT } from '../src/sim/water/constants.ts'
import { applyEdit, type ColumnCells, type EditColumn } from '../src/sim/water/edits.ts'

const { AIR: A, WATER: W, WALL: L } = KIND

/** The column's cells after the write: kinds by y (missing: air), water units by y, and the world height. */
function cells(kinds: number[], units: number[] = [], height = 64): ColumnCells {
  return { height, kind: (y) => kinds[y] ?? A, units: (y) => units[y] ?? 0 }
}

function edit(col: EditColumn, y: number, from: number, to: [number, number], c: ColumnCells = cells([])): EditColumn {
  applyEdit(col, y, from, to[0], to[1], c)
  return col
}

describe('applyEdit', () => {
  it('a wall on the floor in the water raises the floor and keeps the depth: the surface rises by its volume', () => {
    expect(edit({ floor: 2, depth: 3 * SUB }, 2, W, [L, 0])).toEqual({ floor: 3, depth: 3 * SUB })
  })
  it('a wall in the water above the floor pushes the water under it up', () => {
    expect(edit({ floor: 2, depth: 3 * SUB }, 3, W, [L, 0])).toEqual({ floor: 4, depth: 3 * SUB })
  })
  it('a wall in the surface cell counts as in the water', () => {
    expect(edit({ floor: 2, depth: 3 * SUB + 100 }, 5, W, [L, 0])).toEqual({ floor: 6, depth: 3 * SUB + 100 })
  })
  it('ignores a wall above the surface (a bridge), including one resting exactly on it', () => {
    expect(edit({ floor: 2, depth: 3 * SUB }, 6, A, [L, 0])).toEqual({ floor: 2, depth: 3 * SUB })
    expect(edit({ floor: 2, depth: 3 * SUB }, 5, A, [L, 0])).toEqual({ floor: 2, depth: 3 * SUB })
  })
  it('raises a dry column\'s floor for a wall on it, and ignores a floating one', () => {
    expect(edit({ floor: 4, depth: 0 }, 4, A, [L, 0])).toEqual({ floor: 5, depth: 0 })
    expect(edit({ floor: 4, depth: 0 }, 7, A, [L, 0])).toEqual({ floor: 4, depth: 0 })
  })
  it('a raised floor climbs the wall run it now touches: a gap filled under a floating block merges them, as rebuild does', () => {
    // y: 0–1 stone, 2 the new wall (the gap), 3–4 the floating block, 5 air
    expect(edit({ floor: 2, depth: 0 }, 2, A, [L, 0], cells([L, L, L, L, L]))).toEqual({ floor: 5, depth: 0 })
    // in the water: a wall placed right under a block that sits in the water pushes the water over both
    expect(edit({ floor: 2, depth: 3 * SUB }, 3, W, [L, 0], cells([L, L, A, L, L]))).toEqual({ floor: 5, depth: 3 * SUB })
  })
  it('a raised floor climbing a wall run up to the world\'s top row stops at the world height', () => {
    expect(edit({ floor: 2, depth: 0 }, 2, A, [L, 0], cells(Array<number>(32).fill(L), [], 32))).toEqual({ floor: 32, depth: 0 })
  })
  it('ignores a wall below the floor', () => {
    expect(edit({ floor: 4, depth: SUB }, 1, A, [L, 0])).toEqual({ floor: 4, depth: SUB })
  })
  it('drops the floor to the next wall when the floor block is dug out; static water on the way joins the column', () => {
    // y: 0 stone, 1 stone, 2 static water, 3 air, 4 the dug block (now air)
    expect(edit({ floor: 5, depth: 0 }, 4, L, [A, 0], cells([L, L, W, A, A], [0, 0, 8]))).toEqual({ floor: 2, depth: SUB })
  })
  it('drops the floor to the world bottom when nothing is below', () => {
    expect(edit({ floor: 3, depth: 2 * SUB }, 2, L, [A, 0], cells([]))).toEqual({ floor: 0, depth: 2 * SUB })
  })
  it('changes nothing for a wall removed elsewhere (below the floor, or above the water)', () => {
    expect(edit({ floor: 5, depth: SUB }, 2, L, [A, 0])).toEqual({ floor: 5, depth: SUB })
    expect(edit({ floor: 5, depth: SUB }, 9, L, [A, 0])).toEqual({ floor: 5, depth: SUB })
  })
  it('adds water placed at or above the floor, even high above the surface, and ignores water placed below it', () => {
    expect(edit({ floor: 2, depth: SUB }, 9, A, [W, 8])).toEqual({ floor: 2, depth: 2 * SUB })
    expect(edit({ floor: 2, depth: SUB }, 2, A, [W, 3])).toEqual({ floor: 2, depth: SUB + 3 * UNIT })
    expect(edit({ floor: 4, depth: SUB }, 1, A, [W, 8])).toEqual({ floor: 4, depth: SUB })
  })
  it('removes a water cell\'s share of the column: a partial top, a full cell, nothing above the surface', () => {
    expect(edit({ floor: 2, depth: 2 * SUB + 100 }, 4, W, [A, 0])).toEqual({ floor: 2, depth: 2 * SUB })
    expect(edit({ floor: 2, depth: 2 * SUB + 100 }, 2, W, [A, 0])).toEqual({ floor: 2, depth: SUB + 100 })
    expect(edit({ floor: 2, depth: 2 * SUB }, 7, W, [A, 0])).toEqual({ floor: 2, depth: 2 * SUB })
  })
  it('replaces a water cell by another level: out with its share, in with the new units', () => {
    expect(edit({ floor: 2, depth: 2 * SUB }, 3, W, [W, 2])).toEqual({ floor: 2, depth: SUB + 2 * UNIT })
  })
  it('lets a dug floor take the water placed in the dug cell', () => {
    expect(edit({ floor: 4, depth: 0 }, 3, L, [W, 8], cells([L, L, L, W]))).toEqual({ floor: 3, depth: SUB })
  })
})
