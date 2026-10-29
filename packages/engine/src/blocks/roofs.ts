import { stairForm, type Facing } from './shapes.ts'

/**
 * The roof shape (`shape: 'roof'`): a 45° roof of tilted shingle boards, two rows per block, each row a thin board lying
 * over the row below like scales (the colony's mockup B3). Its drawn form — straight, a hip (outer) or valley (inner)
 * corner, an eave at the roof's foot, a gable trim on an open side — comes from the roof cells around it, by shape, so a
 * thatch slope beside a tile slope joins as two tile slopes would. Geometry is a list of planar polygons in sixteenths of
 * a cell that may reach past the cell (eaves, ridge caps); `mesh/roofs.ts` draws them as tilted quads.
 */

/** How far an eave hangs past its cell, in sixteenths (under ½ block, so two roofs one free column apart never touch). */
export const ROOF_OVERHANG = 6

export type RoofKind = 'slope' | 'ridge' | 'apex'
const KIND_NAMES: readonly RoofKind[] = ['slope', 'ridge', 'apex']
const SLOPE = 0, RIDGE = 1, APEX = 2
const kindCode = (state: number): number => { const k = (state >> 2) & 3; return k === 3 ? SLOPE : k }

/**
 * A roof voxel's state: facing in bits 0–1, kind in bits 2–3 (0 slope, 1 ridge, 2 apex). A slope's facing is its high
 * side (as a stair's). A ridge's two halves rise toward its centre line from `facing` and `facing + 2`; the line runs
 * across that axis. An apex (four quarter-slopes meeting above the cell centre) ignores the facing.
 */
export function roofState(kind: RoofKind, facing: Facing = 0): number {
  const k = KIND_NAMES.indexOf(kind)
  if (k < 0) throw new RangeError(`not a roof kind: ${String(kind)}`)
  return (k === APEX ? 0 : facing & 3) | (k << 2)
}

export function roofKindOf(state: number): RoofKind { return KIND_NAMES[kindCode(state)]! }

export type RoofCorner = 'straight' | 'outer' | 'inner'

/**
 * A roof cell's drawn form, derived from its neighbours (`roofForm`). `side`: a corner's second high side (a straight
 * piece's own facing). `eave`: a slope with no roof in front of it one level down hangs its lowest row past the cell.
 * `trimLeft` / `trimRight`: a straight slope or a ridge with no roof on that side (left = facing + 3, right = facing + 1)
 * gets one continuous tilted board along that edge (a gable's barge board).
 */
export interface RoofForm {
  readonly corner: RoofCorner
  readonly side: Facing
  readonly eave: boolean
  readonly trimLeft: boolean
  readonly trimRight: boolean
}

const CORNERS: readonly RoofCorner[] = ['straight', 'outer', 'inner']
/** Form code: corner (bits 0–1) | side << 2 | eave << 4 | trimLeft << 5 | trimRight << 6. */
const formCode = (corner: number, side: number, eave: boolean, trimLeft: boolean, trimRight: boolean): number =>
  corner | (side << 2) | (eave ? 16 : 0) | (trimLeft ? 32 : 0) | (trimRight ? 64 : 0)
const FORMS: readonly RoofForm[] = Array.from({ length: 128 }, (_, c) => Object.freeze({
  corner: CORNERS[Math.min(2, c & 3)]!, side: ((c >> 2) & 3) as Facing, eave: (c & 16) !== 0, trimLeft: (c & 32) !== 0, trimRight: (c & 64) !== 0,
}))

const DX = [1, 0, -1, 0] as const
const DZ = [0, 1, 0, -1] as const

let curAt: (dx: number, dy: number, dz: number) => number = () => -1
/** A same-level neighbour's slope facing for `stairForm`, or −1 (ridges and apexes are not slopes for corners). */
const slopeAt = (dx: number, dz: number): number => { const s = curAt(dx, 0, dz); return s >= 0 && kindCode(s) === SLOPE ? s & 3 : -1 }

/**
 * The form code of a roof cell (see `roofForm`); `at(dx, dy, dz)` returns the roof state of the cell at that offset, or
 * −1 when it holds no roof-shaped block (whatever its id). Reads the 4 horizontal neighbours and the cell in front one
 * level down.
 */
export function roofFormCode(state: number, at: (dx: number, dy: number, dz: number) => number): number {
  const k = kindCode(state), f = state & 3
  if (k === APEX) return 0
  const l = (f + 3) & 3, r = (f + 1) & 3
  const trimLeft = at(DX[l]!, 0, DZ[l]!) < 0, trimRight = at(DX[r]!, 0, DZ[r]!) < 0
  if (k === RIDGE) return formCode(0, f, false, trimLeft, trimRight)
  const eave = at(-DX[f]!, -1, -DZ[f]!) < 0
  curAt = at
  const sf = stairForm(f, slopeAt)
  curAt = () => -1
  if (sf.kind === 'outer') return formCode(1, sf.side, eave, false, false)
  if (sf.kind === 'inner') return formCode(2, sf.side, false, false, false)
  return formCode(0, f, eave, trimLeft, trimRight)
}

/**
 * A roof cell's form from its neighbours, by shape: corners by Minecraft's stair rule (`stairForm`) over same-level
 * slopes, an eave when no roof lies in front one level down, a trim on a straight slope's or ridge's open side. `at` as
 * `roofFormCode`. Returns shared frozen objects.
 */
export function roofForm(state: number, at: (dx: number, dy: number, dz: number) => number): RoofForm {
  return FORMS[roofFormCode(state, at)]!
}

/**
 * One planar polygon of a roof cell: 3 or 4 corners in sixteenths (−6..22 across, up to `16 × ROOF_REACH` past the cell
 * vertically), counter-clockwise seen from its normal's side; `normal` indexes `ROOF_NORMALS`; `cull` is the cell face
 * (0..5: +x −x +y −y +z −z) the polygon lies on, dropped when that neighbour is opaque, or −1 (always drawn).
 */
export interface RoofFace {
  readonly pts: readonly (readonly [number, number, number])[]
  readonly normal: number
  readonly cull: number
}

/** A roof face normal and the axis face (0..5) whose texture projection the face uses: rows along the eave on slopes. */
export interface RoofNormal { readonly n: readonly [number, number, number]; readonly uvFace: number }

// ---- geometry, in a canonical frame: a slope's high side is +x; a corner's second high side is +z --------------------

type V3 = [number, number, number]
interface Poly { pts: V3[]; hint: V3 }
const P = (x: number, y: number, z: number): V3 => [x, y, z]
const poly = (hint: V3, ...pts: V3[]): Poly => ({ pts, hint })
const NX: V3 = [-1, 0, 0], PX: V3 = [1, 0, 0], NY: V3 = [0, -1, 0], PY: V3 = [0, 1, 0], NZ: V3 = [0, 0, -1], PZ: V3 = [0, 0, 1]
/** Up the slope toward +x (board tops, 45° tops), and down toward +x (undersides). */
const UPX: V3 = [-1, 1, 0], DNX: V3 = [1, -1, 0]
/** x ↔ z (a corner's second half); winding is fixed later from the hint. */
const swap = (p: Poly): Poly => ({ pts: p.pts.map(([x, y, z]) => P(z, y, x)), hint: [p.hint[2], p.hint[1], p.hint[0]] })
/** Quarter turns about the cell centre, +x → +z. */
function turn(p: Poly, q: number): Poly {
  let pts = p.pts, hint = p.hint
  for (let i = 0; i < q; i++) {
    pts = pts.map(([x, y, z]) => P(16 - z, y, x))
    hint = [-hint[2], hint[1], hint[0]]
  }
  return { pts, hint }
}
const turnAll = (ps: Poly[], q: number): Poly[] => ps.map((p) => turn(p, q))

/*
 * Proportions (sixteenths; colony mockup B3): the roof line rises 1:1. Each block holds two shingle rows 8 long; a row is a
 * board 2 thick whose lower edge is kicked up 2 off the row below, so its top runs from (a, a + 4) to (a + 8, a + 10)
 * and the next row's butt (its visible thickness) stands at x = a + 8 from a + 10 to a + 12. The eave board follows the
 * roof line 2 thick past the cell by ROOF_OVERHANG; trims and caps stand 6 above the roof line.
 */
const KICK = 2, BOARD = 2, ROW = 8, LIFT = KICK + BOARD
/** The two shingle rows of a straight slope, along z0..z1: per row its butt (the first one down to the cell floor) and top. */
function rows(z0: number, z1: number): Poly[] {
  const out: Poly[] = []
  for (let a = 0; a < 16; a += ROW) {
    const b = a + ROW, y0 = a === 0 ? 0 : a + KICK
    out.push(poly(NX, P(a, y0, z0), P(a, a + LIFT, z0), P(a, a + LIFT, z1), P(a, y0, z1)))
    out.push(poly(UPX, P(a, a + LIFT, z0), P(b, b + KICK, z0), P(b, b + KICK, z1), P(a, a + LIFT, z1)))
  }
  return out
}

/** The eave board under the first row, along z0..z1: it follows the roof line out to −ROOF_OVERHANG. */
function eave(z0: number, z1: number): Poly[] {
  const o = -ROOF_OVERHANG
  return [
    poly(UPX, P(o, o + BOARD, z0), P(0, BOARD, z0), P(0, BOARD, z1), P(o, o + BOARD, z1)),
    poly(NX, P(o, o, z0), P(o, o + BOARD, z0), P(o, o + BOARD, z1), P(o, o, z1)),
    poly(DNX, P(o, o, z0), P(0, 0, z0), P(0, 0, z1), P(o, o, z1)),
  ]
}

const TRIM_W = 2, TRIM_H = 6
/** A straight slope's open side at z = zs (s = −1 left, +1 right): the wedge's side below the roof line and the trim. */
function trimSide(zs: number, s: number, hasEave: boolean): Poly[] {
  const zo = zs + s * TRIM_W, x0 = hasEave ? -ROOF_OVERHANG : 0, out = P(0, 0, s), inn = P(0, 0, -s)
  const ps = [
    poly(out, P(0, 0, zs), P(16, 0, zs), P(16, 16, zs)),
    poly(out, P(x0, x0, zo), P(16, 16, zo), P(16, 16 + TRIM_H, zo), P(x0, x0 + TRIM_H, zo)),
    poly(UPX, P(x0, x0 + TRIM_H, zs), P(16, 16 + TRIM_H, zs), P(16, 16 + TRIM_H, zo), P(x0, x0 + TRIM_H, zo)),
    poly(DNX, P(x0, x0, zs), P(16, 16, zs), P(16, 16, zo), P(x0, x0, zo)),
    // Its inner side where it stands above the shingles.
    poly(inn, P(0, LIFT, zs), P(8, 8 + KICK, zs), P(8, 8 + TRIM_H, zs), P(0, TRIM_H, zs)),
    poly(inn, P(8, 8 + LIFT, zs), P(16, 16 + KICK, zs), P(16, 16 + TRIM_H, zs), P(8, 8 + TRIM_H, zs)),
    poly(PX, P(16, 16, zs), P(16, 16, zo), P(16, 16 + TRIM_H, zo), P(16, 16 + TRIM_H, zs)),
  ]
  if (hasEave) {
    const o = -ROOF_OVERHANG
    ps.push(poly(inn, P(o, o + BOARD, zs), P(0, BOARD, zs), P(0, TRIM_H, zs), P(o, o + TRIM_H, zs)))
    ps.push(poly(NX, P(o, o, zs), P(o, o, zo), P(o, o + TRIM_H, zo), P(o, o + TRIM_H, zs)))
  }
  return ps
}

const bottom = (): Poly => poly(NY, P(0, 0, 0), P(16, 0, 0), P(16, 0, 16), P(0, 0, 16))
/** The +x side of a cell, full, and the strip above it up to the last row's top. */
const backX = (top = 16): Poly[] => [
  poly(PX, P(16, 0, 0), P(16, 16, 0), P(16, 16, 16), P(16, 0, 16)),
  ...(top > 16 ? [poly(PX, P(16, 16, 0), P(16, top, 0), P(16, top, 16), P(16, 16, 16))] : []),
]
/** The shingle profile (y up to the rows' tops, rising along z) on the plane x = px, facing `hint`. */
const profileX = (px: number, hint: V3): Poly[] => [
  poly(hint, P(px, 0, 0), P(px, 0, 8), P(px, 8 + KICK, 8), P(px, LIFT, 0)),
  poly(hint, P(px, 0, 8), P(px, 0, 16), P(px, 16 + KICK, 16), P(px, 8 + LIFT, 8)),
]

function slopeStraight(hasEave: boolean, trimLeft: boolean, trimRight: boolean): Poly[] {
  const ps = [bottom(), ...backX(16 + KICK), ...rows(0, 16)]
  if (hasEave) ps.push(...eave(0, 16))
  if (trimLeft) ps.push(...trimSide(0, -1, hasEave))
  if (trimRight) ps.push(...trimSide(16, 1, hasEave))
  return ps
}

/** A hip cap along the diagonal (t, t, t) + `base` from t = ta to tb: the roof surface raised 6 over a strip ±2 across. */
function hipCap(ta: number, tb: number, base: number, lowEnd: boolean, highEnd: boolean): Poly[] {
  const C = (t: number) => P(t, base + t + TRIM_H, t), E1 = (t: number) => P(t + 2, base + t + 4, t - 2), E2 = (t: number) => P(t - 2, base + t + 4, t + 2)
  const B1 = (t: number) => P(t + 2, base + t, t - 2), B2 = (t: number) => P(t - 2, base + t, t + 2)
  const ps = [
    poly([0, 1, -1], C(ta), E1(ta), E1(tb), C(tb)),
    poly(UPX, C(ta), C(tb), E2(tb), E2(ta)),
    poly([1, 0, -1], B1(ta), B1(tb), E1(tb), E1(ta)),
    poly([-1, 0, 1], B2(ta), E2(ta), E2(tb), B2(tb)),
  ]
  if (lowEnd) ps.push(poly([-1, 0, -1], B1(ta), E1(ta), C(ta), E2(ta)), poly([-1, 0, -1], B1(ta), E2(ta), B2(ta)))
  if (highEnd) ps.push(poly([1, 0, 1], B1(tb), E1(tb), C(tb), E2(tb)), poly([1, 0, 1], B1(tb), E2(tb), B2(tb)))
  return ps
}

/** Outer (hip) corner: y = min(x, z); half A (z ≥ x) rises along x, half B (x ≥ z) along z; a cap along the hip. */
function slopeOuter(hasEave: boolean): Poly[] {
  const a: Poly[] = [
    poly(NX, P(0, 0, 0), P(0, LIFT, 0), P(0, LIFT, 16), P(0, 0, 16)),
    poly(UPX, P(0, LIFT, 0), P(8, 8 + KICK, 8), P(8, 8 + KICK, 16), P(0, LIFT, 16)),
    poly(NX, P(8, 8 + KICK, 8), P(8, 8 + LIFT, 8), P(8, 8 + LIFT, 16), P(8, 8 + KICK, 16)),
    poly(UPX, P(8, 8 + LIFT, 8), P(16, 16 + KICK, 16), P(8, 8 + LIFT, 16)),
    ...profileX(16, PX),
  ]
  if (hasEave) {
    const o = -ROOF_OVERHANG
    a.push(
      poly(UPX, P(o, o + BOARD, o), P(0, BOARD, 0), P(0, BOARD, 16), P(o, o + BOARD, 16)),
      poly(NX, P(o, o, o), P(o, o + BOARD, o), P(o, o + BOARD, 16), P(o, o, 16)),
      poly(DNX, P(o, o, o), P(0, 0, 0), P(0, 0, 16), P(o, o, 16)),
    )
  }
  return [bottom(), ...a, ...a.map(swap), ...hipCap(hasEave ? -4 : 0, 16, 0, hasEave, true)]
}

/** Inner (valley) corner: y = max(x, z); half A (x ≥ z) rises along x, half B (z ≥ x) along z; a board in the valley. */
function slopeInner(): Poly[] {
  const a: Poly[] = [
    poly(UPX, P(0, LIFT, 0), P(8, 8 + KICK, 0), P(8, 8 + KICK, 8)),
    poly(NX, P(8, 8 + KICK, 0), P(8, 8 + LIFT, 0), P(8, 8 + LIFT, 8), P(8, 8 + KICK, 8)),
    poly(UPX, P(8, 8 + LIFT, 0), P(16, 16 + KICK, 0), P(16, 16 + KICK, 16), P(8, 8 + LIFT, 8)),
    ...backX(16 + KICK),
    ...profileX(0, NX),
  ]
  // The valley board: a strip ±4 across the diagonal at y = (x + z) / 2 + 5, its edges under the shingles.
  const valley = poly([-1, 2, -1], P(4, 5, -4), P(20, 21, 12), P(12, 21, 20), P(-4, 5, 4))
  return [bottom(), ...a, ...a.map(swap), valley]
}

/** Ridge (canonical facing 0): halves rise from x = 0 and x = 16 to the line x = 8 past the cell top; a cap on the line. */
function ridge(trimLeft: boolean, trimRight: boolean): Poly[] {
  const half: Poly[] = [
    poly(NX, P(0, 0, 0), P(0, 16, 0), P(0, 16, 16), P(0, 0, 16)),
    poly(NX, P(0, 16, 0), P(0, 16 + LIFT, 0), P(0, 16 + LIFT, 16), P(0, 16, 16)),
    poly(UPX, P(0, 16 + LIFT, 0), P(8, 16 + 8 + KICK, 0), P(8, 16 + 8 + KICK, 16), P(0, 16 + LIFT, 16)),
    // The cap's half: its 45° top and its side down into the shingles.
    poly(UPX, P(4, 26, 0), P(8, 30, 0), P(8, 30, 16), P(4, 26, 16)),
    poly(NX, P(4, 22, 0), P(4, 26, 0), P(4, 26, 16), P(4, 22, 16)),
  ]
  const mirrorX = (p: Poly): Poly => ({ pts: p.pts.map(([x, y, z]) => P(16 - x, y, z)), hint: [-p.hint[0], p.hint[1], p.hint[2]] })
  const ps = [bottom(), ...half, ...half.map(mirrorX)]
  const side = (zs: number, s: number): Poly[] => {
    const zo = zs + s * TRIM_W, out = P(0, 0, s), inn = P(0, 0, -s)
    return [
      poly(out, P(0, 0, zs), P(16, 0, zs), P(16, 16, zs), P(0, 16, zs)),
      poly(out, P(0, 16, zs), P(16, 16, zs), P(8, 24, zs)),
      poly(out, P(0, 16, zo), P(8, 24, zo), P(8, 30, zo), P(0, 22, zo)),
      poly(out, P(8, 24, zo), P(16, 16, zo), P(16, 22, zo), P(8, 30, zo)),
      poly(UPX, P(0, 22, zs), P(8, 30, zs), P(8, 30, zo), P(0, 22, zo)),
      poly([1, 1, 0], P(16, 22, zs), P(8, 30, zs), P(8, 30, zo), P(16, 22, zo)),
      poly(DNX, P(0, 16, zs), P(8, 24, zs), P(8, 24, zo), P(0, 16, zo)),
      poly([-1, -1, 0], P(16, 16, zs), P(8, 24, zs), P(8, 24, zo), P(16, 16, zo)),
      poly(inn, P(0, 20, zs), P(8, 26, zs), P(8, 30, zs), P(0, 22, zs)),
      poly(inn, P(8, 26, zs), P(16, 20, zs), P(16, 22, zs), P(8, 30, zs)),
    ]
  }
  if (trimLeft) ps.push(...side(0, -1))
  if (trimRight) ps.push(...side(16, 1))
  return ps
}

/** Apex: four quarter-slopes from the cell's top edges to (8, 24, 8), hip caps on the diagonals and a small cap block. */
function apex(): Poly[] {
  const quarter: Poly[] = [
    poly(NX, P(0, 0, 0), P(0, 16, 0), P(0, 16, 16), P(0, 0, 16)),
    poly(NX, P(0, 16, 0), P(0, 16 + LIFT, 0), P(0, 16 + LIFT, 16), P(0, 16, 16)),
    poly(UPX, P(0, 16 + LIFT, 0), P(8, 16 + 8 + KICK, 8), P(0, 16 + LIFT, 16)),
    ...hipCap(0, 8, 16, false, false),
  ]
  const cap: Poly[] = [
    poly(PY, P(5, 31, 5), P(11, 31, 5), P(11, 31, 11), P(5, 31, 11)),
    poly(NX, P(5, 23, 5), P(5, 31, 5), P(5, 31, 11), P(5, 23, 11)),
  ]
  return [bottom(), ...[0, 1, 2, 3].flatMap((q) => turnAll(quarter, q)), cap[0]!, ...[0, 1, 2, 3].map((q) => turn(cap[1]!, q))]
}

// ---- placing, normals, cache -------------------------------------------------------------------------------------

interface Placed { pts: V3[]; n: V3; cull: number }

/** Mirrors z (a corner turned the other way), turns by `q`, orders each polygon counter-clockwise about its hint. */
function place(ps: Poly[], mirror: boolean, q: number): Placed[] {
  return ps.map((p0) => {
    let p = mirror ? { pts: p0.pts.map(([x, y, z]) => P(x, y, 16 - z)), hint: [p0.hint[0], p0.hint[1], -p0.hint[2]] as V3 } : p0
    p = turn(p, q)
    let pts = p.pts
    const n = newell(pts)
    if (n[0] * p.hint[0] + n[1] * p.hint[1] + n[2] * p.hint[2] < 0) { pts = [...pts].reverse(); n[0] = -n[0]; n[1] = -n[1]; n[2] = -n[2] }
    const len = Math.hypot(n[0], n[1], n[2])
    if (len === 0) throw new Error('roof: degenerate polygon')
    const u: V3 = [n[0] / len, n[1] / len, n[2] / len]
    return { pts, n: u, cull: cullOf(pts, u) }
  })
}

function newell(pts: readonly V3[]): V3 {
  const n: V3 = [0, 0, 0]
  pts.forEach((p, i) => {
    const q = pts[(i + 1) % pts.length]!
    n[0] += (p[1] - q[1]) * (p[2] + q[2]); n[1] += (p[2] - q[2]) * (p[0] + q[0]); n[2] += (p[0] - q[0]) * (p[1] + q[1])
  })
  return n
}

/** The cell face an axis-aligned polygon lies on, facing out, wholly inside the cell's side; else −1. */
function cullOf(pts: readonly V3[], n: V3): number {
  const axis = n.findIndex((c) => Math.abs(c) > 0.9999)
  if (axis < 0) return -1
  const plane = n[axis]! > 0 ? 16 : 0
  if (!pts.every((p) => p[axis] === plane && p.every((c) => c >= 0 && c <= 16))) return -1
  return axis * 2 + (n[axis]! > 0 ? 0 : 1)
}

/** Geometry key: the kind, facing and the parts of the form that change the polygons. */
function geomKey(state: number, code: number): number {
  const k = kindCode(state), f = state & 3
  const key = (kind: number, fc: number, c: number, m: number, e: number, l: number, r: number) => ((((((kind * 4 + fc) * 3 + c) * 2 + m) * 2 + e) * 2 + l) * 2 + r)
  if (k === APEX) return key(APEX, 0, 0, 0, 0, 0, 0)
  const e = (code >> 4) & 1, l = (code >> 5) & 1, r = (code >> 6) & 1
  if (k === RIDGE) return key(RIDGE, f, 0, 0, 0, l, r)
  const c = Math.min(2, code & 3), rel = (((code >> 2) & 3) - f) & 3
  if (c === 0 || (rel !== 1 && rel !== 3)) return key(SLOPE, f, 0, 0, e, l, r)
  return c === 1 ? key(SLOPE, f, 1, rel === 3 ? 1 : 0, e, 0, 0) : key(SLOPE, f, 2, rel === 3 ? 1 : 0, 0, 0, 0)
}

function build(state: number, code: number): Placed[] {
  const k = kindCode(state), f = state & 3
  if (k === APEX) return place(apex(), false, 0)
  const tl = (code & 32) !== 0, tr = (code & 64) !== 0, e = (code & 16) !== 0
  if (k === RIDGE) return place(ridge(tl, tr), false, f)
  const c = Math.min(2, code & 3), rel = (((code >> 2) & 3) - f) & 3
  if (c === 0 || (rel !== 1 && rel !== 3)) return place(slopeStraight(e, tl, tr), false, f)
  return place(c === 1 ? slopeOuter(e) : slopeInner(), rel === 3, f)
}

const nKey = (n: readonly number[]) => n.map((c) => Math.round(c * 1e6)).join(',')
/** The axis face whose projection a normal's texture uses: its own for axis normals, else the dominant horizontal side. */
function uvFaceOf(n: V3): number {
  const axis = n.findIndex((c) => Math.abs(c) > 0.9999)
  if (axis >= 0) return axis * 2 + (n[axis]! > 0 ? 0 : 1)
  if (Math.abs(n[0]) >= Math.abs(n[2]) && n[0] !== 0) return n[0] > 0 ? 0 : 1
  if (n[2] !== 0) return n[2] > 0 ? 4 : 5
  return n[1] > 0 ? 2 : 3
}

const placedByKey = new Map<number, Placed[]>()
for (let state = 0; state < 12; state++) for (let code = 0; code < 128; code++) {
  if ((code & 3) === 3) continue
  const key = geomKey(state, code)
  if (!placedByKey.has(key)) placedByKey.set(key, build(state, code))
}

const normalIndex = new Map<string, number>()
const normals: RoofNormal[] = []
for (const n of [PX, NX, PY, NY, PZ, NZ]) { normalIndex.set(nKey(n), normals.length); normals.push(Object.freeze({ n: Object.freeze([...n]) as readonly [number, number, number], uvFace: uvFaceOf(n) })) }
let reach = 0
for (const list of placedByKey.values()) for (const p of list) {
  const key = nKey(p.n)
  if (!normalIndex.has(key)) { normalIndex.set(key, normals.length); normals.push(Object.freeze({ n: Object.freeze([...p.n]) as readonly [number, number, number], uvFace: uvFaceOf(p.n) })) }
  for (const q of p.pts) for (const c of q) reach = Math.max(reach, -c, c - 16)
}
if (normals.length > 32) throw new Error(`roof: ${normals.length} face normals, the vertex format holds 32`)

/** Every unit normal a roof face can have (axis normals first, in face order), with its texture projection face. */
export const ROOF_NORMALS: readonly RoofNormal[] = Object.freeze(normals)
/** How far any roof geometry reaches past its cell, in blocks (eaves across, ridge and apex caps up). */
export const ROOF_REACH = reach / 16

const facesByKey = new Map<number, readonly RoofFace[]>()
for (const [key, list] of placedByKey) {
  facesByKey.set(key, Object.freeze(list.map((p) => Object.freeze({
    pts: Object.freeze(p.pts.map((q) => Object.freeze(q) as readonly [number, number, number])),
    normal: normalIndex.get(nKey(p.n))!,
    cull: p.cull,
  }))))
}

/** A roof cell's polygons for a form code (`roofFormCode`). Shared frozen arrays. */
export function roofFacesOf(state: number, code: number): readonly RoofFace[] {
  return facesByKey.get(geomKey(state, code))!
}

/** A roof cell's polygons for its state and drawn form. Shared frozen arrays, cached per (kind, facing, form). */
export function roofFaces(state: number, form: RoofForm): readonly RoofFace[] {
  return roofFacesOf(state, formCode(CORNERS.indexOf(form.corner), form.side, form.eave, form.trimLeft, form.trimRight))
}
