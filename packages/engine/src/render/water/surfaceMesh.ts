import { SUB } from '../../world/waterBuffers.ts'

/** Neighbours whose surfaces lie within this of each other share corners; a larger drop gets a curtain (spec §5: ~1 block). */
export const JOIN = SUB
/** Columns shallower than this (1/16 block, the mirror's threshold) are not drawn: thinner films would z-fight the ground. */
export const SHOW_MIN = 16
/** A column that is not drawn has its corners this far (blocks) under its ground, so a drying column sinks out of sight. */
export const SINK = 0.02
/** Below this speed (blocks per second) the ripples stand still… */
export const FLOW_STILL = 0.15
/** …below this they drift gently (1), above it steeply (2.5): 3a's two flow speeds. */
export const FLOW_STEEP = 1.5
/** Gravity (blocks/s², one block a metre) of the Froude number speed / √(g · depth) white water is measured by. */
export const GRAVITY = 9.8
/** Depths are counted as at least this (blocks) in the Froude number: thinner films are not faster for it. */
export const FROUDE_MIN_DEPTH = 1 / 8
/**
 * A surface whitens past this Froude number, one level (of 15) per unit: well past the hydraulic-jump range, so a steep
 * steady stream (the flood river: Fr 3–6) stays clear and only its shallow fast lips (Fr ~11) get a light edge.
 */
export const WHITE_FROUDE = 7.5
/** A sheet running onto dry ground (a bore) whitens past this Froude number, 3 levels per unit: a breaking jump's start. */
export const BORE_FROUDE = 1.7

/** speed (blocks/s) / √(GRAVITY × depth (blocks, at least FROUDE_MIN_DEPTH)). */
export function froude(speed: number, depth: number): number {
  return speed / Math.sqrt(GRAVITY * Math.max(depth, FROUDE_MIN_DEPTH))
}

/** White water (0–15) of a surface at Froude number fr. */
export function surfaceWhite(fr: number): number {
  return fr > WHITE_FROUDE ? Math.min(15, Math.round(fr - WHITE_FROUDE)) : 0
}

/** White water (0–15) of a front running onto dry ground at Froude number fr. */
export function boreWhite(fr: number): number {
  return fr > BORE_FROUDE ? Math.min(15, Math.round((fr - BORE_FROUDE) * 3)) : 0
}

/** Corner offsets, in the order (−x,−z) (+x,−z) (+x,+z) (−x,+z). */
export const CORNER_X: readonly number[] = [-1, 1, 1, -1]
export const CORNER_Z: readonly number[] = [-1, -1, 1, 1]
/** Curtain directions 0 +x, 1 −x, 2 +z, 3 −z: the neighbour's offset. */
export const DIR_X: readonly number[] = [1, -1, 0, 0]
export const DIR_Z: readonly number[] = [0, 0, 1, -1]
/** Per direction, the upper column's corners at the edge's ends A and B… */
export const CURTAIN_TOP: readonly (readonly [number, number])[] = [[1, 2], [3, 0], [2, 3], [0, 1]]
/** …and the lower neighbour's corners at the same ends. */
export const CURTAIN_BOTTOM: readonly (readonly [number, number])[] = [[0, 3], [2, 1], [1, 0], [3, 2]]

/** The level (1/SUB block) a published value stands for: a wet column's surface, a dry one's ground. */
export function level(v: number): number { return v >= 0 ? v : ~v }

/** Whether a column (published value v, floor `floor`) is drawn: wet and at least SHOW_MIN deep. */
export function shows(v: number, floor: number): boolean { return v >= 0 && v - floor * SUB >= SHOW_MIN }

/** The effective value of a column outside the world: never drawn, and its "ground" lies above everything. */
export const OUTSIDE = -0x80000000

/**
 * A column's effective value for corners and curtains: its surface S (≥ 0) when drawn, ~level (< 0) when not. Unlike the
 * published value, a wet column too shallow to draw counts as ground, at its surface.
 */
export function effective(v: number, floor: number): number { return shows(v, floor) ? v : v >= 0 ? ~v : v }

const vVal = new Float64Array(4)
const vKind = new Int8Array(4) // 0 outside the world, 1 not drawn (its ground counts), 2 drawn (its surface counts)
const vGroup = new Int8Array(4)

/** Whether two of a vertex's columns join: two drawn surfaces within JOIN, or a drawn surface and a ground below it within JOIN. */
function joins(a: number, b: number): boolean {
  const ka = vKind[a]!, kb = vKind[b]!, va = vVal[a]!, vb = vVal[b]!
  if (ka === 2 && kb === 2) return Math.abs(va - vb) <= JOIN
  if (ka === 2 && kb === 1) return vb < va && va - vb <= JOIN
  if (ka === 1 && kb === 2) return va < vb && vb - va <= JOIN
  return false
}

/**
 * Heights (blocks) at one vertex for the four columns around it, given their effective values (`effective`, or OUTSIDE)
 * e0 (−x,−z) e1 (+x,−z) e2 (−x,+z) e3 (+x,+z), into out[o + q] for column q; columns outside are left alone (plan design
 * notes: Rendering). The columns are grouped by single linkage, where:
 * - two drawn columns join when their surfaces lie within JOIN;
 * - a drawn column joins the ground of an undrawn one that lies below it within JOIN (a film's edge thins to the ground).
 * Each drawn column gets its group's average, so every column of a group (in particular two neighbours whose surfaces lie
 * within JOIN) shares the vertex. Higher ground (walls) and drops beyond JOIN stay apart; curtains hang there. A column that
 * is not drawn gets its ground minus SINK.
 * Returns whether the vertex is smooth: four drawn columns within JOIN of each other, so no curtain hangs between them.
 */
export function vertexShares(e0: number, e1: number, e2: number, e3: number, out: Float32Array, o: number): boolean {
  if (e0 >= 0 && e1 >= 0 && e2 >= 0 && e3 >= 0) { // the common case, inside a lake or a river
    const lo01 = e0 < e1 ? e0 : e1, hi01 = e0 < e1 ? e1 : e0, lo23 = e2 < e3 ? e2 : e3, hi23 = e2 < e3 ? e3 : e2
    if ((hi01 > hi23 ? hi01 : hi23) - (lo01 < lo23 ? lo01 : lo23) <= JOIN) {
      const h = (e0 + e1 + e2 + e3) * (1 / (4 * SUB)) // a power of two: exact
      out[o] = h; out[o + 1] = h; out[o + 2] = h; out[o + 3] = h
      return true
    }
  }
  vVal[0] = e0; vVal[1] = e1; vVal[2] = e2; vVal[3] = e3
  let drawn = 0
  for (let q = 0; q < 4; q++) {
    const w = vVal[q]!
    if (w === OUTSIDE) { vKind[q] = 0; continue }
    if (w >= 0) { vKind[q] = 2; drawn++; continue }
    vKind[q] = 1
    vVal[q] = ~w
    out[o + q] = ~w / SUB - SINK
  }
  if (drawn === 0) return false
  for (let q = 0; q < 4; q++) vGroup[q] = q
  for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
    const ga = vGroup[a]!, gb = vGroup[b]!
    if (ga !== gb && joins(a, b)) for (let q = 0; q < 4; q++) if (vGroup[q] === gb) vGroup[q] = ga
  }
  for (let q = 0; q < 4; q++) {
    if (vKind[q] !== 2) continue
    let gs = 0, n = 0
    for (let m = 0; m < 4; m++) if (vKind[m] !== 0 && vGroup[m] === vGroup[q]) { gs += vVal[m]!; n++ }
    out[o + q] = gs / n / SUB
  }
  return false
}

/** Effective value of column (x, z) of `s`, or OUTSIDE. */
function at(s: Int32Array, floor: Int16Array, sx: number, sz: number, x: number, z: number): number {
  if (x < 0 || z < 0 || x >= sx || z >= sz) return OUTSIDE
  const j = x + z * sx
  return effective(s[j]!, floor[j]!)
}

/** vertexShares at vertex (vx, vz) of the published surfaces `s`: out[o + q] for column (vx − 1 + (q & 1), vz − 1 + (q >> 1)). */
export function vertexHeights(s: Int32Array, floor: Int16Array, sx: number, sz: number, vx: number, vz: number, out: Float32Array, o: number): boolean {
  return vertexShares(
    at(s, floor, sx, sz, vx - 1, vz - 1), at(s, floor, sx, sz, vx, vz - 1),
    at(s, floor, sx, sz, vx - 1, vz), at(s, floor, sx, sz, vx, vz), out, o,
  )
}

const vertex = new Float32Array(4)

/**
 * Corner heights (blocks) of column (x, z) of the published surfaces `s`, into out[o..o+3], in the order (−x,−z) (+x,−z)
 * (+x,+z) (−x,+z): its share of each of its four vertices (vertexHeights). Returns whether the column is drawn.
 */
export function cornerHeights(s: Int32Array, floor: Int16Array, sx: number, sz: number, x: number, z: number, out: Float32Array, o: number): boolean {
  const c = x + z * sx, v = s[c]!
  if (!shows(v, floor[c]!)) {
    const g = level(v) / SUB - SINK
    out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = g
    return false
  }
  vertexHeights(s, floor, sx, sz, x, z, vertex, 0); out[o] = vertex[3]!
  vertexHeights(s, floor, sx, sz, x + 1, z, vertex, 0); out[o + 1] = vertex[2]!
  vertexHeights(s, floor, sx, sz, x + 1, z + 1, vertex, 0); out[o + 2] = vertex[0]!
  vertexHeights(s, floor, sx, sz, x, z + 1, vertex, 0); out[o + 3] = vertex[1]!
  return true
}

/** Whether edge c → j (j beside c) needs a curtain in `s`: c is drawn and stands more than JOIN above j's level. */
export function curtainAt(s: Int32Array, floor: Int16Array, c: number, j: number): boolean {
  return shows(s[c]!, floor[c]!) && s[c]! - level(s[j]!) > JOIN
}

/** tan(22.5°): the octant borders around the axes. */
const TAN_8 = Math.tan(Math.PI / 8)
/** The 16 moving flows, (x, z) per direction (0 = +x, counter-clockwise from +x toward +z by 45°) × gentle (1) / steep (2.5). */
const FLOWS = new Float64Array(32)
for (let dir = 0; dir < 8; dir++) for (let s = 0; s < 2; s++) {
  const k = s === 0 ? 1 : 2.5, o = (dir * 2 + s) * 2
  FLOWS[o] = Math.cos((dir * Math.PI) / 4) * k
  FLOWS[o + 1] = Math.sin((dir * Math.PI) / 4) * k
}

/** Ripple flow for a column velocity (blocks per second) into out[o], out[o + 1]: 8 directions × still / 1 / 2.5. Returns the speed. */
export function quantizeFlow(vx: number, vz: number, out: Float32Array, o: number): number {
  const speed = Math.sqrt(vx * vx + vz * vz)
  if (speed < FLOW_STILL) { out[o] = 0; out[o + 1] = 0; return speed }
  const ax = Math.abs(vx), az = Math.abs(vz)
  const dir = az <= ax * TAN_8 ? (vx > 0 ? 0 : 4)
    : ax <= az * TAN_8 ? (vz > 0 ? 2 : 6)
    : vx > 0 ? (vz > 0 ? 1 : 7) : (vz > 0 ? 3 : 5)
  const f = (dir * 2 + (speed < FLOW_STEEP ? 0 : 1)) * 2
  out[o] = FLOWS[f]!
  out[o + 1] = FLOWS[f + 1]!
  return speed
}
