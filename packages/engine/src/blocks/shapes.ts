/** A block type's form other than the whole cube. */
export type BlockShape = 'slab' | 'stair' | 'post' | 'ladder' | 'roof'
/** Shape codes as stored in `BlockRegistry.shape`; 0 is the whole cube. */
export const SHAPE = { CUBE: 0, SLAB: 1, STAIR: 2, POST: 3, LADDER: 4, ROOF: 5 } as const
export const SHAPE_CODE: Record<BlockShape, number> = { slab: SHAPE.SLAB, stair: SHAPE.STAIR, post: SHAPE.POST, ladder: SHAPE.LADDER, roof: SHAPE.ROOF }

/** A horizontal direction: 0 +x, 1 +z, 2 −x, 3 −z; one quarter turn adds 1 (+x → +z). */
export type Facing = 0 | 1 | 2 | 3
/** A post's long axis: `y` stands, `x`/`z` lie as beams. */
export type PostAxis = 'y' | 'x' | 'z'

const DX = [1, 0, -1, 0] as const
const DZ = [0, 1, 0, -1] as const
const UPSIDE_DOWN = 4
const POST_AXES: readonly PostAxis[] = ['y', 'x', 'z']

/** A slab's voxel state: bottom half (y 0..½) or top half (y ½..1). */
export function slabState(top: boolean): number { return top ? 1 : 0 }
/** A stair's voxel state: its facing (the high side) in bits 0–1, upside down in bit 2. */
export function stairState(facing: Facing, upsideDown = false): number { return (facing & 3) | (upsideDown ? UPSIDE_DOWN : 0) }
/** A post's voxel state: 0 upright (y), 1 an x beam, 2 a z beam. */
export function postState(axis: PostAxis): number { return POST_AXES.indexOf(axis) }

/** A ladder's voxel state: the side it hangs on (the side holding its wall), as a stair's facing. */
export function ladderState(facing: Facing): number { return facing & 3 }

/**
 * Turns a shaped voxel's state by quarter turns (negative turns allowed): stairs, ladders and roofs turn their facing
 * (bits 0–1; a roof keeps its kind in bits 2–3, an apex stays), beams swap x/z on odd turns, slabs stay.
 */
export function turnShapeState(shape: BlockShape, state: number, quarterTurns: number): number {
  if (!Number.isInteger(quarterTurns)) throw new RangeError(`quarter turns must be an integer: ${quarterTurns}`)
  const q = ((quarterTurns % 4) + 4) % 4
  if (shape === 'roof' && ((state >> 2) & 3) === 2) return state // an apex has no facing
  if (shape === 'stair' || shape === 'ladder' || shape === 'roof') return (state & ~3) | (((state & 3) + q) & 3)
  if (shape === 'post' && (q & 1) === 1 && (state === 1 || state === 2)) return 3 - state
  return state
}

/** A stair's drawn form, derived from its neighbours: straight, or an outer/inner corner whose second high side is `side`. */
export type StairForm = { kind: 'straight' } | { kind: 'outer' | 'inner'; side: Facing }

const STRAIGHT: StairForm = Object.freeze({ kind: 'straight' })
const OUTER: readonly StairForm[] = ([0, 1, 2, 3] as const).map((side) => Object.freeze({ kind: 'outer' as const, side }))
const INNER: readonly StairForm[] = ([0, 1, 2, 3] as const).map((side) => Object.freeze({ kind: 'inner' as const, side }))

/**
 * A stair's form from the stairs beside it, Minecraft's `StairBlock.getStairsShape`: if the stair on its high side has the
 * same half and faces across it (facing G), an outer corner turned to G — unless the cell on its −G side holds a stair
 * with its own facing and half (`canTakeShape`); else the same test on its low side gives an inner corner, checked
 * against the cell on its +G side. `neighbour(dx, dz)` returns the stair state of the cell at that offset, or −1 when
 * it holds no stair. Reads only the four horizontal neighbours. Returns shared objects.
 */
export function stairForm(state: number, neighbour: (dx: number, dz: number) => number): StairForm {
  const f = state & 3
  const half = state & UPSIDE_DOWN
  const back = neighbour(DX[f]!, DZ[f]!)
  if (back >= 0 && (back & UPSIDE_DOWN) === half && ((back - f) & 1) === 1) {
    const g = back & 3
    if (canTakeShape(state, neighbour(-DX[g]!, -DZ[g]!))) return OUTER[g]!
  }
  const front = neighbour(-DX[f]!, -DZ[f]!)
  if (front >= 0 && (front & UPSIDE_DOWN) === half && ((front - f) & 1) === 1) {
    const g = front & 3
    if (canTakeShape(state, neighbour(DX[g]!, DZ[g]!))) return INNER[g]!
  }
  return STRAIGHT
}

/** Minecraft's `canTakeShape`: the side cell is not a stair with this stair's facing and half. */
const canTakeShape = (state: number, side: number): boolean => side < 0 || (side & 7) !== (state & 7)

/** An axis-aligned box in a cell, in sixteenths (0..16). */
export type Box = readonly [x0: number, y0: number, z0: number, x1: number, y1: number, z1: number]

/** Turns a box about the cell centre by quarter turns (+x → +z). */
function turnBox(b: Box, q: number): Box {
  let [x0, y0, z0, x1, y1, z1] = b
  for (let i = 0; i < q; i++) [x0, z0, x1, z1] = [16 - z1, x0, 16 - z0, x1]
  return [x0, y0, z0, x1, y1, z1]
}
const flipY = (b: Box): Box => [b[0], 16 - b[4], b[2], b[3], 16 - b[1], b[5]]

const SLAB_LOW: Box = [0, 0, 0, 16, 8, 16]
const HIGH_HALF: Box = [8, 8, 0, 16, 16, 16]
// Upright stair facing +x; the second index is the corner side relative to the facing: 1 = one turn (+z), 3 = three (−z).
const OUTER_QUAD: Record<1 | 3, Box> = { 1: [8, 8, 8, 16, 16, 16], 3: [8, 8, 0, 16, 16, 8] }
const INNER_QUAD: Record<1 | 3, Box> = { 1: [0, 8, 8, 8, 16, 16], 3: [0, 8, 0, 8, 16, 8] }

/** Stair boxes by `state & 7` then form index (0 straight, 1 + side outer, 5 + side inner). */
const STAIR_BOXES: (readonly Box[])[][] = []
for (let s = 0; s < 8; s++) {
  const f = s & 3
  const orient = (bs: Box[]): readonly Box[] => Object.freeze(bs.map((b) => {
    const t = turnBox(b, f)
    return Object.freeze(s & UPSIDE_DOWN ? flipY(t) : t) as Box
  }))
  const row: (readonly Box[])[] = [orient([SLAB_LOW, HIGH_HALF])]
  for (const kind of ['outer', 'inner'] as const) {
    for (let side = 0; side < 4; side++) {
      const rel = (side - f) & 3
      if (rel !== 1 && rel !== 3) { row.push(row[0]!); continue } // not a corner across this stair: drawn straight
      row.push(orient(kind === 'outer' ? [SLAB_LOW, OUTER_QUAD[rel]] : [SLAB_LOW, HIGH_HALF, INNER_QUAD[rel]]))
    }
  }
  STAIR_BOXES.push(row)
}
const SLAB_BOXES: readonly (readonly Box[])[] = [[SLAB_LOW], [flipY(SLAB_LOW)]]
const POST_BOXES: readonly (readonly Box[])[] = [[[5, 0, 5, 11, 16, 11]], [[0, 5, 5, 16, 11, 11]], [[5, 5, 0, 11, 11, 16]]]
// A ladder hanging on +x: two rails 2/16 wide and four rungs between them, all 2/16 thick against the +x side.
const LADDER_X: Box[] = [
  [14, 0, 2, 16, 16, 4], [14, 0, 12, 16, 16, 14],
  [14, 1, 4, 16, 3, 12], [14, 5, 4, 16, 7, 12], [14, 9, 4, 16, 11, 12], [14, 13, 4, 16, 15, 12],
]
const LADDER_BOXES: readonly (readonly Box[])[] = [0, 1, 2, 3].map((f) => Object.freeze(LADDER_X.map((b) => Object.freeze(turnBox(b, f)) as Box)))

const NO_BOXES: readonly Box[] = Object.freeze([])

/** The non-overlapping boxes a shaped voxel draws; `form` is read only for stairs. Shared, frozen arrays. A roof draws no boxes (blocks/roofs.ts roofFaces). */
export function shapeBoxes(code: number, state: number, form: StairForm): readonly Box[] {
  if (code === SHAPE.ROOF) return NO_BOXES
  if (code === SHAPE.STAIR) {
    const i = form.kind === 'straight' ? 0 : (form.kind === 'outer' ? 1 : 5) + form.side
    return STAIR_BOXES[state & 7]![i]!
  }
  if (code === SHAPE.SLAB) return SLAB_BOXES[state & 1]!
  if (code === SHAPE.POST) return POST_BOXES[state < 3 ? state : 0]!
  if (code === SHAPE.LADDER) return LADDER_BOXES[state & 3]!
  throw new RangeError(`not a shape code: ${code}`)
}
